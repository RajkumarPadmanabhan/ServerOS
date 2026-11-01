package com.serveros.phone;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;

final class PhoneFiles {
    private final File root;

    PhoneFiles(File root) {
        this.root = root;
        if (!root.exists() && !root.mkdirs()) {
            throw new IllegalStateException("Could not create the phone folder.");
        }
    }

    File root() {
        return root;
    }

    JSONObject list(String rel) throws Exception {
        File dir = resolve(rel, false);
        if (!dir.exists() || !dir.isDirectory()) {
            throw new IllegalArgumentException("That folder was not found.");
        }
        File[] kids = dir.listFiles();
        JSONArray entries = new JSONArray();
        if (kids != null) {
            java.util.Arrays.sort(kids, new java.util.Comparator<File>() {
                public int compare(File a, File b) {
                    if (a.isDirectory() != b.isDirectory()) return a.isDirectory() ? -1 : 1;
                    return a.getName().compareToIgnoreCase(b.getName());
                }
            });
            for (int i = 0; i < kids.length; i++) {
                if (kids[i].getName().startsWith(".")) continue;
                String child = join(rel, kids[i].getName());
                entries.put(entry(child, kids[i]));
            }
        }
        JSONObject out = new JSONObject();
        out.put("path", rel == null ? "" : rel);
        out.put("entries", entries);
        return out;
    }

    JSONObject mkdir(String rel, String name) throws Exception {
        String safe = safeName(name);
        File parent = resolve(rel, false);
        if (!parent.exists() || !parent.isDirectory()) {
            throw new IllegalArgumentException("That folder was not found.");
        }
        File dest = new File(parent, safe);
        if (dest.exists()) {
            if (dest.isDirectory()) return entry(join(rel, safe), dest);
            throw new IllegalArgumentException("That name is already used by a file.");
        }
        if (!dest.mkdir()) throw new IllegalArgumentException("Could not create that folder.");
        return entry(join(rel, safe), dest);
    }

    void remove(String rel) throws Exception {
        if (rel == null || rel.length() == 0) throw new IllegalArgumentException("Choose a file first.");
        File target = resolve(rel, false);
        if (!target.exists()) throw new IllegalArgumentException("That was not found.");
        deleteAll(target);
    }

    JSONObject rename(String rel, String name) throws Exception {
        if (rel == null || rel.length() == 0) throw new IllegalArgumentException("Choose a file first.");
        File target = resolve(rel, false);
        if (!target.exists()) throw new IllegalArgumentException("That was not found.");
        String safe = safeName(name);
        File dest = new File(target.getParentFile(), safe);
        if (dest.exists()) throw new IllegalArgumentException("That name is already used.");
        if (!target.renameTo(dest)) throw new IllegalArgumentException("Could not rename that.");
        String parent = parentRel(rel);
        return entry(join(parent, safe), dest);
    }

    JSONObject usage() {
        long[] totals = new long[2];
        walk(root, totals);
        JSONObject out = new JSONObject();
        try {
            out.put("bytes", totals[0]);
            out.put("files", totals[1]);
        } catch (Exception ignored) {}
        return out;
    }

    File beginUpload(String id) throws IOException {
        File tmp = new File(root, ".up-" + id);
        File parent = tmp.getParentFile();
        if (parent != null && !parent.exists()) parent.mkdirs();
        return tmp;
    }

    JSONObject finishUpload(String dir, String name, File tmp) throws Exception {
        String safe = safeName(name);
        File parent = resolve(dir, true);
        if (!parent.exists() && !parent.mkdirs()) throw new IllegalArgumentException("Could not open that folder.");
        File dest = unique(parent, safe);
        if (!tmp.renameTo(dest)) {
            copy(tmp, dest);
            tmp.delete();
        }
        return entry(join(dir, dest.getName()), dest);
    }

    File existingFile(String rel) throws Exception {
        File file = resolve(rel, false);
        if (!file.exists() || !file.isFile()) throw new IllegalArgumentException("That file was not found.");
        return file;
    }

    private File unique(File parent, String name) {
        File dest = new File(parent, name);
        if (!dest.exists()) return dest;
        int dot = name.lastIndexOf('.');
        String stem = dot > 0 ? name.substring(0, dot) : name;
        String ext = dot > 0 ? name.substring(dot) : "";
        for (int i = 1; i <= 500; i++) {
            File next = new File(parent, stem + " (" + i + ")" + ext);
            if (!next.exists()) return next;
        }
        return dest;
    }

    private void copy(File from, File to) throws IOException {
        FileInputStream in = new FileInputStream(from);
        try {
            FileOutputStream out = new FileOutputStream(to);
            try {
                byte[] buf = new byte[8192];
                int n;
                while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            } finally {
                out.close();
            }
        } finally {
            in.close();
        }
    }

    private void walk(File dir, long[] totals) {
        File[] kids = dir.listFiles();
        if (kids == null) return;
        for (int i = 0; i < kids.length; i++) {
            if (kids[i].getName().startsWith(".")) continue;
            if (kids[i].isDirectory()) walk(kids[i], totals);
            else {
                totals[0] += kids[i].length();
                totals[1] += 1;
            }
        }
    }

    private void deleteAll(File file) {
        if (file.isDirectory()) {
            File[] kids = file.listFiles();
            if (kids != null) {
                for (int i = 0; i < kids.length; i++) deleteAll(kids[i]);
            }
        }
        file.delete();
    }

    private JSONObject entry(String rel, File file) throws Exception {
        JSONObject out = new JSONObject();
        out.put("name", file.getName());
        out.put("path", rel == null ? "" : rel);
        out.put("kind", file.isDirectory() ? "folder" : "file");
        out.put("size", file.isDirectory() ? 0 : file.length());
        out.put("modified", file.lastModified());
        return out;
    }

    private String parentRel(String rel) {
        int slash = rel.lastIndexOf('/');
        if (slash < 0) return "";
        return rel.substring(0, slash);
    }

    private String join(String parent, String name) {
        if (parent == null || parent.length() == 0) return name;
        return parent + "/" + name;
    }

    private String safeName(String name) {
        String value = name == null ? "" : name.trim();
        if (value.length() == 0 || value.indexOf('/') >= 0 || value.indexOf('\\') >= 0 || value.indexOf(':') >= 0) {
            throw new IllegalArgumentException("Use a plain file name.");
        }
        if (value.equals(".") || value.equals("..") || value.startsWith(".")) {
            throw new IllegalArgumentException("That name is not allowed.");
        }
        return value;
    }

    private File resolve(String rel, boolean create) throws IOException {
        File current = root;
        if (rel == null || rel.length() == 0) return current;
        String cleaned = rel.replace('\\', '/');
        if (cleaned.startsWith("/")) throw new IllegalArgumentException("That path is not allowed.");
        String[] parts = cleaned.split("/");
        for (int i = 0; i < parts.length; i++) {
            String part = parts[i];
            if (part.length() == 0 || part.equals(".") || part.equals("..")) {
                throw new IllegalArgumentException("That path is not allowed.");
            }
            current = new File(current, part);
        }
        String rootPath = root.getCanonicalPath();
        File parent = current.getParentFile();
        if (create && parent != null && !parent.exists()) parent.mkdirs();
        String full = current.exists() ? current.getCanonicalPath() : new File(parent, current.getName()).getAbsolutePath();
        if (!full.startsWith(rootPath)) throw new IllegalArgumentException("That path is not allowed.");
        return current;
    }
}
