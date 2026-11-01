package com.serveros.phone;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.Socket;
import java.net.URL;
import java.security.SecureRandom;
import java.util.HashMap;

public class LinkService extends Service {
    static volatile String status = "Not connected";

    private final SecureRandom random = new SecureRandom();
    private volatile boolean stopped;
    private Thread worker;
    private PhoneFiles files;
    private final HashMap<String, Upload> uploads = new HashMap<String, Upload>();
    private Download download;

    public IBinder onBind(Intent intent) {
        return null;
    }

    public int onStartCommand(Intent intent, int flags, int startId) {
        note("Connecting to your computer");
        if (intent != null) {
            SharedPreferences prefs = getSharedPreferences("serveros", MODE_PRIVATE);
            prefs.edit()
                .putString("url", intent.getStringExtra("url"))
                .putString("login", intent.getStringExtra("login"))
                .putString("password", intent.getStringExtra("password"))
                .putString("device", intent.getStringExtra("device"))
                .apply();
        }
        if (worker == null) {
            stopped = false;
            worker = new Thread(new Runnable() {
                public void run() {
                    loop();
                }
            });
            worker.start();
        }
        return START_STICKY;
    }

    public void onDestroy() {
        stopped = true;
        if (worker != null) worker.interrupt();
    }

    private void loop() {
        File dir = getExternalFilesDir(null);
        if (dir == null) dir = getFilesDir();
        files = new PhoneFiles(new File(dir, "files"));
        try {
            File ready = new File(files.root(), "phone-ready.txt");
            if (!ready.exists()) {
                FileOutputStream out = new FileOutputStream(ready);
                try {
                    out.write("This file is on the phone.".getBytes("UTF-8"));
                } finally {
                    out.close();
                }
            }
        } catch (Exception ignored) {}
        while (!stopped) {
            try {
                connectOnce();
            } catch (Exception err) {
                setStatus(err.getMessage() == null ? "Could not reach the computer." : err.getMessage());
            }
            if (stopped) break;
            try { Thread.sleep(3000); } catch (InterruptedException ignored) { break; }
        }
    }

    private void connectOnce() throws Exception {
        SharedPreferences prefs = getSharedPreferences("serveros", MODE_PRIVATE);
        String home = prefs.getString("url", "");
        String login = prefs.getString("login", "");
        String password = prefs.getString("password", "");
        String device = prefs.getString("device", "My phone");
        String deviceId = prefs.getString("deviceId", "");
        if (home == null || home.length() == 0 || login == null || login.length() == 0) {
            setStatus("Enter the computer address and your login.");
            stopped = true;
            return;
        }
        setStatus("Signing in");
        String token = loginToken(home, login, password);
        URL url = new URL(home);
        String host = url.getHost();
        int port = url.getPort();
        if (port < 0) port = 80;
        Socket socket = new Socket(host, port);
        try {
            socket.setTcpNoDelay(true);
            OutputStream rawOut = socket.getOutputStream();
            InputStream rawIn = socket.getInputStream();
            byte[] key = new byte[16];
            random.nextBytes(key);
            String keyText = android.util.Base64.encodeToString(key, android.util.Base64.NO_WRAP);
            String req = "GET /api/link HTTP/1.1\r\nHost: " + host + ":" + port
                + "\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: "
                + keyText + "\r\n\r\n";
            rawOut.write(req.getBytes("UTF-8"));
            rawOut.flush();
            String headers = readHeaders(rawIn);
            if (headers.indexOf(" 101 ") < 0 && headers.indexOf("101 ") < 0) {
                throw new IllegalStateException("The computer did not accept this phone.");
            }
            JSONObject hello = new JSONObject();
            hello.put("type", "hello");
            hello.put("token", token);
            hello.put("deviceName", device == null || device.length() == 0 ? "My phone" : device);
            hello.put("platform", "Android");
            if (deviceId != null && deviceId.length() > 0) hello.put("deviceId", deviceId);
            sendFrame(rawOut, 1, hello.toString().getBytes("UTF-8"));
            ByteArrayOutputStream text = new ByteArrayOutputStream();
            while (!stopped && socket.isConnected()) {
                Frame frame = readFrame(rawIn);
                if (frame.opcode == 8) break;
                if (frame.opcode == 9) {
                    sendFrame(rawOut, 10, frame.payload);
                    continue;
                }
                if (frame.opcode == 10) continue;
                if (frame.opcode == 0 || frame.opcode == 1) {
                    text.write(frame.payload);
                    if (frame.fin) {
                        String body = text.toString("UTF-8");
                        text.reset();
                        handle(rawOut, body, prefs);
                    }
                }
            }
        } finally {
            try { socket.close(); } catch (Exception ignored) {}
        }
        if (!stopped) setStatus("The computer is not reachable. Leave ServerOS open there.");
    }

    private void handle(OutputStream rawOut, String body, SharedPreferences prefs) throws Exception {
        JSONObject msg = new JSONObject(body);
        String type = msg.optString("type", "");
        if ("welcome".equals(type)) {
            String id = msg.optString("deviceId", "");
            if (id.length() > 0) prefs.edit().putString("deviceId", id).apply();
            setStatus("Connected. This phone and the computer can see each other.");
            sendUsage(rawOut);
            return;
        }
        if ("removed".equals(type)) {
            prefs.edit().remove("deviceId").apply();
            stopped = true;
            setStatus("This phone was removed on the computer.");
            return;
        }
        if ("ack".equals(type)) {
            if (download != null && msg.optString("id").equals(download.id)) sendNextDownload(rawOut);
            return;
        }
        if ("op".equals(type)) {
            String id = msg.optString("id");
            try {
                Object data = runOp(msg);
                JSONObject res = new JSONObject();
                res.put("type", "res");
                res.put("id", id);
                res.put("ok", true);
                res.put("data", data == null ? JSONObject.NULL : data);
                sendJson(rawOut, res);
                sendUsage(rawOut);
            } catch (Exception err) {
                JSONObject res = new JSONObject();
                res.put("type", "res");
                res.put("id", id);
                res.put("ok", false);
                res.put("error", err.getMessage() == null ? "Could not do that." : err.getMessage());
                sendJson(rawOut, res);
            }
            return;
        }
        if ("download".equals(type)) startDownload(rawOut, msg);
        else if ("upload-start".equals(type)) startUpload(rawOut, msg);
        else if ("upload-chunk".equals(type)) writeChunk(rawOut, msg);
        else if ("upload-end".equals(type)) finishUpload(rawOut, msg);
        else if ("cancel".equals(type)) {
            uploads.remove(msg.optString("id"));
            if (download != null && msg.optString("id").equals(download.id)) download = null;
        }
    }

    private Object runOp(JSONObject msg) throws Exception {
        String op = msg.optString("op", "");
        String path = msg.optString("path", "");
        if ("list".equals(op)) return files.list(path);
        if ("mkdir".equals(op)) return files.mkdir(path, msg.optString("name", ""));
        if ("delete".equals(op)) {
            files.remove(path);
            JSONObject ok = new JSONObject();
            ok.put("ok", true);
            return ok;
        }
        if ("rename".equals(op)) return files.rename(path, msg.optString("name", ""));
        if ("usage".equals(op)) return files.usage();
        throw new IllegalArgumentException("That action is not available.");
    }

    private void startDownload(OutputStream rawOut, JSONObject msg) throws Exception {
        String id = msg.optString("id");
        try {
            File file = files.existingFile(msg.optString("path", ""));
            download = new Download();
            download.id = id;
            download.file = file;
            download.offset = 0;
            JSONObject meta = new JSONObject();
            meta.put("type", "download-meta");
            meta.put("id", id);
            meta.put("name", file.getName());
            meta.put("size", file.length());
            meta.put("mime", "application/octet-stream");
            meta.put("inlineOk", false);
            sendJson(rawOut, meta);
            sendNextDownload(rawOut);
        } catch (Exception err) {
            JSONObject bad = new JSONObject();
            bad.put("type", "err");
            bad.put("id", id);
            bad.put("error", err.getMessage() == null ? "That file was not found." : err.getMessage());
            sendJson(rawOut, bad);
        }
    }

    private void sendNextDownload(OutputStream rawOut) throws Exception {
        if (download == null) return;
        if (download.offset >= download.file.length()) {
            JSONObject end = new JSONObject();
            end.put("type", "download-end");
            end.put("id", download.id);
            download = null;
            sendJson(rawOut, end);
            return;
        }
        int size = (int) Math.min(256 * 1024, download.file.length() - download.offset);
        byte[] buf = new byte[size];
        FileInputStream in = new FileInputStream(download.file);
        try {
            long left = download.offset;
            while (left > 0) {
                long skipped = in.skip(left);
                if (skipped <= 0) break;
                left -= skipped;
            }
            int got = 0;
            while (got < size) {
                int n = in.read(buf, got, size - got);
                if (n < 0) break;
                got += n;
            }
        } finally {
            in.close();
        }
        download.offset += size;
        JSONObject chunk = new JSONObject();
        chunk.put("type", "download-chunk");
        chunk.put("id", download.id);
        chunk.put("data", android.util.Base64.encodeToString(buf, android.util.Base64.NO_WRAP));
        sendJson(rawOut, chunk);
    }

    private void startUpload(OutputStream rawOut, JSONObject msg) throws Exception {
        String id = msg.optString("id");
        Upload item = new Upload();
        item.id = id;
        item.dir = msg.optString("dir", "");
        item.name = msg.optString("name", "file");
        item.tmp = files.beginUpload(id);
        item.out = new FileOutputStream(item.tmp);
        uploads.put(id, item);
        JSONObject ready = new JSONObject();
        ready.put("type", "upload-ready");
        ready.put("id", id);
        sendJson(rawOut, ready);
    }

    private void writeChunk(OutputStream rawOut, JSONObject msg) throws Exception {
        Upload item = uploads.get(msg.optString("id"));
        if (item == null) return;
        byte[] data = android.util.Base64.decode(msg.optString("data", ""), android.util.Base64.DEFAULT);
        item.out.write(data);
        JSONObject ack = new JSONObject();
        ack.put("type", "upload-ack");
        ack.put("id", item.id);
        sendJson(rawOut, ack);
    }

    private void finishUpload(OutputStream rawOut, JSONObject msg) throws Exception {
        String id = msg.optString("id");
        Upload item = uploads.remove(id);
        if (item == null) return;
        item.out.close();
        JSONObject result = new JSONObject();
        result.put("type", "upload-result");
        result.put("id", id);
        try {
            result.put("ok", true);
            result.put("entry", files.finishUpload(item.dir, item.name, item.tmp));
            sendUsage(rawOut);
        } catch (Exception err) {
            item.tmp.delete();
            result.put("ok", false);
            result.put("error", err.getMessage() == null ? "Could not save that file." : err.getMessage());
        }
        sendJson(rawOut, result);
    }

    private void sendUsage(OutputStream rawOut) throws Exception {
        JSONObject usage = files.usage();
        JSONObject status = new JSONObject();
        status.put("type", "status");
        status.put("usedBytes", usage.optLong("bytes"));
        status.put("fileCount", usage.optLong("files"));
        sendJson(rawOut, status);
    }

    private String loginToken(String home, String login, String password) throws Exception {
        String base = home.endsWith("/") ? home.substring(0, home.length() - 1) : home;
        HttpURLConnection conn = (HttpURLConnection) new URL(base + "/api/login").openConnection();
        conn.setConnectTimeout(8000);
        conn.setReadTimeout(8000);
        conn.setRequestMethod("POST");
        conn.setDoOutput(true);
        conn.setRequestProperty("Content-Type", "application/json");
        JSONObject body = new JSONObject();
        body.put("login", login);
        body.put("password", password);
        body.put("link", true);
        byte[] bytes = body.toString().getBytes("UTF-8");
        conn.setFixedLengthStreamingMode(bytes.length);
        OutputStream out = conn.getOutputStream();
        out.write(bytes);
        out.close();
        InputStream in = conn.getResponseCode() >= 400 ? conn.getErrorStream() : conn.getInputStream();
        ByteArrayOutputStream buf = new ByteArrayOutputStream();
        byte[] tmp = new byte[2048];
        int n;
        if (in != null) {
            while ((n = in.read(tmp)) > 0) buf.write(tmp, 0, n);
            in.close();
        }
        JSONObject json = new JSONObject(buf.toString("UTF-8"));
        if (conn.getResponseCode() != 200 || !json.has("token")) {
            throw new IllegalStateException(json.optString("error", "Could not log in to that computer."));
        }
        return json.getString("token");
    }

    private void sendJson(OutputStream rawOut, JSONObject json) throws Exception {
        sendFrame(rawOut, 1, json.toString().getBytes("UTF-8"));
    }

    private void sendFrame(OutputStream rawOut, int opcode, byte[] payload) throws Exception {
        int len = payload == null ? 0 : payload.length;
        ByteArrayOutputStream frame = new ByteArrayOutputStream();
        frame.write(0x80 | opcode);
        if (len < 126) frame.write(0x80 | len);
        else if (len < 65536) {
            frame.write(0x80 | 126);
            frame.write((len >> 8) & 0xff);
            frame.write(len & 0xff);
        } else {
            frame.write(0x80 | 127);
            for (int shift = 56; shift >= 0; shift -= 8) frame.write((int) ((len >> shift) & 0xff));
        }
        byte[] mask = new byte[4];
        random.nextBytes(mask);
        frame.write(mask);
        if (payload != null) {
            for (int i = 0; i < payload.length; i++) frame.write(payload[i] ^ mask[i & 3]);
        }
        synchronized (rawOut) {
            rawOut.write(frame.toByteArray());
            rawOut.flush();
        }
    }

    private String readHeaders(InputStream in) throws Exception {
        ByteArrayOutputStream buf = new ByteArrayOutputStream();
        int matched = 0;
        int[] marker = new int[] { '\r', '\n', '\r', '\n' };
        while (matched < 4) {
            int b = in.read();
            if (b < 0) throw new IllegalStateException("The computer closed the connection.");
            buf.write(b);
            if (b == marker[matched]) matched++;
            else matched = b == marker[0] ? 1 : 0;
            if (buf.size() > 8192) throw new IllegalStateException("The computer sent an unexpected reply.");
        }
        return buf.toString("UTF-8");
    }

    private Frame readFrame(InputStream in) throws Exception {
        int b0 = in.read();
        int b1 = in.read();
        if (b0 < 0 || b1 < 0) throw new IllegalStateException("The computer closed the connection.");
        Frame frame = new Frame();
        frame.fin = (b0 & 0x80) != 0;
        frame.opcode = b0 & 0x0f;
        long len = b1 & 0x7f;
        boolean masked = (b1 & 0x80) != 0;
        if (len == 126) len = ((in.read() & 0xff) << 8) | (in.read() & 0xff);
        else if (len == 127) {
            len = 0;
            for (int i = 0; i < 8; i++) len = (len << 8) | (in.read() & 0xff);
        }
        byte[] mask = null;
        if (masked) {
            mask = new byte[4];
            readFully(in, mask);
        }
        if (len > 4 * 1024 * 1024) throw new IllegalStateException("That message was too large.");
        frame.payload = new byte[(int) len];
        readFully(in, frame.payload);
        if (mask != null) {
            for (int i = 0; i < frame.payload.length; i++) frame.payload[i] = (byte) (frame.payload[i] ^ mask[i & 3]);
        }
        return frame;
    }

    private void readFully(InputStream in, byte[] buf) throws Exception {
        int got = 0;
        while (got < buf.length) {
            int n = in.read(buf, got, buf.length - got);
            if (n < 0) throw new IllegalStateException("The computer closed the connection.");
            got += n;
        }
    }

    private void setStatus(String text) {
        status = text;
        note(text);
    }

    private void note(String text) {
        String channel = "serveros-link";
        NotificationManager manager = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationChannel made = new NotificationChannel(channel, "ServerOS", NotificationManager.IMPORTANCE_LOW);
            manager.createNotificationChannel(made);
        }
        Notification.Builder builder = Build.VERSION.SDK_INT >= 26
            ? new Notification.Builder(this, channel)
            : new Notification.Builder(this);
        builder.setSmallIcon(android.R.drawable.stat_notify_sync)
            .setContentTitle("ServerOS")
            .setContentText(text)
            .setOngoing(true);
        Notification notification = builder.build();
        if (Build.VERSION.SDK_INT >= 34) {
            startForeground(1, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
        } else {
            startForeground(1, notification);
        }
    }

    private static final class Frame {
        boolean fin;
        int opcode;
        byte[] payload;
    }

    private static final class Upload {
        String id;
        String dir;
        String name;
        File tmp;
        FileOutputStream out;
    }

    private static final class Download {
        String id;
        File file;
        long offset;
    }
}
