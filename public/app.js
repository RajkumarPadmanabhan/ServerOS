(function () {
  var state = {
    mode: "setup",
    user: null,
    devices: [],
    deviceId: "",
    path: "",
    entries: [],
    onThisDevice: true,
    accountExists: false,
    needsOwnerCode: false,
    uploading: false
  };
  var pollTimer = null;
  var setupTimer = null;
  var nodeTimer = null;

  function $(id) { return document.getElementById(id); }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null && text !== "") node.textContent = text;
    return node;
  }

  function show(id) {
    var ids = ["bootScreen", "setupScreen", "authScreen", "appScreen", "nodeScreen"];
    for (var i = 0; i < ids.length; i++) {
      var node = $(ids[i]);
      if (!node) continue;
      if (ids[i] === id) node.classList.remove("hidden");
      else node.classList.add("hidden");
    }
  }

  function showAuth(panel) {
    show("authScreen");
    var panels = ["loginPanel", "registerPanel", "recoverPanel", "localPanel"];
    for (var i = 0; i < panels.length; i++) {
      if (panels[i] === panel) $(panels[i]).classList.remove("hidden");
      else $(panels[i]).classList.add("hidden");
    }
    if (panel === "registerPanel" && $("regIntro")) {
      $("regIntro").textContent = state.accountExists
        ? "Create your own login. You can open the owner's files, and your files stay separate."
        : "This is the first account. It owns this ServerOS.";
    }
  }

  function toast(message, isError) {
    var node = el("div", "toast" + (isError ? " toast-error" : ""), message);
    $("toasts").appendChild(node);
    setTimeout(function () {
      if (node.parentNode) node.parentNode.removeChild(node);
    }, 4200);
  }

  function api(method, url, body, cb, timeoutMs) {
    var xhr = new XMLHttpRequest();
    xhr.open(method, url, true);
    var isForm = false;
    if (typeof FormData !== "undefined" && body && body instanceof FormData) isForm = true;
    if (body && !isForm) xhr.setRequestHeader("Content-Type", "application/json; charset=utf-8");
    xhr.timeout = timeoutMs == null ? 60000 : timeoutMs;
    xhr.onreadystatechange = function () {
      if (xhr.readyState !== 4) return;
      var data = {};
      if (xhr.responseText) {
        try { data = JSON.parse(xhr.responseText); } catch (e) { data = {}; }
      }
      if (xhr.status >= 200 && xhr.status < 300) cb(null, data);
      else {
        var err = new Error((data && data.error) || "Something went wrong.");
        err.status = xhr.status;
        cb(err, data);
      }
    };
    xhr.onerror = function () {
      cb(new Error("Cannot reach ServerOS. The device may be off."));
    };
    xhr.ontimeout = function () {
      cb(new Error("This is taking too long. Check that the device is still on."));
    };
    if (isForm) xhr.send(body);
    else if (body) xhr.send(JSON.stringify(body));
    else xhr.send();
  }

  function stopPoll() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
  }
  function stopSetupPoll() {
    if (setupTimer) clearInterval(setupTimer);
    setupTimer = null;
  }
  function stopNodePoll() {
    if (nodeTimer) clearInterval(nodeTimer);
    nodeTimer = null;
  }

  function startSetupPoll() {
    stopSetupPoll();
    setupTimer = setInterval(function () {
      api("GET", "/api/bootstrap", null, function (err, data) {
        if (err || !data) return;
        if (data.mode !== "setup" || data.accountExists || data.user) applyBootstrap(data);
      });
    }, 4000);
  }

  function startNodePoll() {
    stopNodePoll();
    nodeTimer = setInterval(function () {
      api("GET", "/api/bootstrap", null, function (err, data) {
        if (err || !data) return;
        if (data.mode !== "linked") applyBootstrap(data);
        else renderNode(data.node || {});
      });
    }, 4000);
  }

  function selectedDevice() {
    for (var i = 0; i < state.devices.length; i++) {
      if (state.devices[i].id === state.deviceId) return state.devices[i];
    }
    return null;
  }

  function formatSize(n) {
    n = Number(n) || 0;
    if (n < 1024) return n + " B";
    if (n < 1048576) return (n / 1024).toFixed(1) + " KB";
    if (n < 1073741824) return (n / 1048576).toFixed(1) + " MB";
    return (n / 1073741824).toFixed(2) + " GB";
  }

  function formatWhen(ms) {
    try { return new Date(ms).toLocaleString(); } catch (e) { return ""; }
  }

  function extOf(name) {
    var i = String(name || "").lastIndexOf(".");
    if (i === -1) return "";
    return name.slice(i + 1).toLowerCase();
  }

  function badge(entry) {
    if (entry.kind === "folder") return "DIR";
    var ext = extOf(entry.name);
    if (ext === "png" || ext === "jpg" || ext === "jpeg" || ext === "gif" || ext === "webp") return "IMG";
    if (ext === "mp3" || ext === "wav" || ext === "m4a" || ext === "ogg") return "AUD";
    if (ext === "mp4" || ext === "webm" || ext === "mov") return "VID";
    if (ext === "pdf") return "PDF";
    if (ext === "txt" || ext === "md" || ext === "json" || ext === "csv" || ext === "log") return "TXT";
    return "FILE";
  }

  function renderBanner() {
    $("statusBanner").textContent = state.onThisDevice
      ? "You can close this browser tab. Keep the ServerOS window running for live access. A backup copied to another device can still be opened if this one is off."
      : "You are using ServerOS from another device. Live files open while the device that has them is on. Backups already copied here stay available.";
  }

  function svgEl(name) {
    return document.createElementNS("http://www.w3.org/2000/svg", name);
  }

  function shortName(name) {
    var value = String(name || "Device");
    if (value.length > 22) return value.slice(0, 21) + "…";
    return value;
  }

  function renderDevices() {
    var box = $("deviceList");
    box.innerHTML = "";
    var used = 0;
    var files = 0;
    var online = 0;
    for (var n = 0; n < state.devices.length; n++) {
      used += state.devices[n].usedBytes || 0;
      files += state.devices[n].fileCount || 0;
      if (state.devices[n].online) online += 1;
    }
    if ($("storageLine")) $("storageLine").textContent = formatSize(used);
    if ($("storageMeta")) {
      $("storageMeta").textContent = state.devices.length
        ? files + (files === 1 ? " file · " : " files · ") + online + " of " + state.devices.length + " online"
        : "No devices yet";
    }
    var svg = svgEl("svg");
    svg.setAttribute("class", "device-map");
    svg.setAttribute("viewBox", "0 0 900 560");
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", "Map of your devices");
    box.appendChild(svg);
    var count = state.devices.length;
    var hub = svgEl("circle");
    hub.setAttribute("cx", "170");
    hub.setAttribute("cy", "280");
    hub.setAttribute("r", "62");
    hub.setAttribute("fill", "#241b4a");
    hub.setAttribute("stroke", "#7c5cff");
    hub.setAttribute("stroke-width", "3");
    svg.appendChild(hub);
    var hubText = svgEl("text");
    hubText.setAttribute("x", "170");
    hubText.setAttribute("y", "276");
    hubText.setAttribute("text-anchor", "middle");
    hubText.setAttribute("class", "map-label");
    hubText.textContent = "ServerOS";
    svg.appendChild(hubText);
    var hubSub = svgEl("text");
    hubSub.setAttribute("x", "170");
    hubSub.setAttribute("y", "296");
    hubSub.setAttribute("text-anchor", "middle");
    hubSub.setAttribute("class", "map-sub");
    hubSub.textContent = count === 1 ? "1 device" : count + " devices";
    svg.appendChild(hubSub);
    for (var i = 0; i < count; i++) {
      var device = state.devices[i];
      var y = count === 1 ? 280 : 70 + (i * (420 / (count - 1)));
      var x = 560;
      var path = svgEl("path");
      path.setAttribute("d", "M 232 280 C 380 " + y + ", 460 280, " + (x - 18) + " " + y);
      path.setAttribute("fill", "none");
      path.setAttribute("stroke", device.id === state.deviceId ? "#f0a04b" : "#b99762");
      path.setAttribute("stroke-width", device.id === state.deviceId ? "2.4" : "1.2");
      path.setAttribute("opacity", "0.85");
      svg.appendChild(path);
      var group = svgEl("g");
      group.setAttribute("class", "map-node");
      group.setAttribute("data-id", device.id);
      var hit = svgEl("rect");
      hit.setAttribute("x", String(x - 20));
      hit.setAttribute("y", String(y - 24));
      hit.setAttribute("width", "250");
      hit.setAttribute("height", "48");
      hit.setAttribute("fill", "transparent");
      group.appendChild(hit);
      var dot = svgEl("circle");
      dot.setAttribute("cx", String(x));
      dot.setAttribute("cy", String(y));
      dot.setAttribute("r", device.id === state.deviceId ? "9" : "7");
      dot.setAttribute("fill", device.online ? "#3ddc97" : "#6d7284");
      group.appendChild(dot);
      var label = svgEl("text");
      label.setAttribute("x", String(x + 16));
      label.setAttribute("y", String(y - 2));
      label.setAttribute("class", "map-label");
      label.textContent = shortName(device.name);
      group.appendChild(label);
      var sub = svgEl("text");
      sub.setAttribute("x", String(x + 16));
      sub.setAttribute("y", String(y + 16));
      sub.setAttribute("class", "map-sub");
      sub.textContent = (device.shared ? "Shared · " : "") + (device.online ? "Online" : "Offline") + " · " + formatSize(device.usedBytes);
      group.appendChild(sub);
      svg.appendChild(group);
    }
    renderDeviceDetail();
  }

  function statBox(label, value) {
    var box = el("div", "stat");
    box.appendChild(el("span", "eyebrow", label));
    box.appendChild(el("strong", "", value));
    return box;
  }

  function renderDeviceDetail() {
    var box = $("deviceDetail");
    if (!box) return;
    box.innerHTML = "";
    var device = selectedDevice();
    if (!device) {
      box.appendChild(el("h2", "", "No device yet"));
      box.appendChild(el("p", "small", "Create the account on this computer, then join from a phone or another computer."));
      return;
    }
    var kicker = el("p", "detail-kicker" + (device.online ? "" : " off"), device.online ? "Online" : "Offline");
    box.appendChild(kicker);
    box.appendChild(el("h2", "", device.name));
    box.appendChild(el("p", "small", device.platform + " · " + (device.role === "home" ? "Main device" : "Linked device")));
    var grid = el("div", "stat-grid");
    grid.appendChild(statBox("Files", String(device.fileCount || 0)));
    grid.appendChild(statBox("Stored", formatSize(device.usedBytes)));
    grid.appendChild(statBox("Role", device.role === "home" ? "Main" : "Extra"));
    grid.appendChild(statBox("Live files", device.online ? "Open" : "Waiting"));
    box.appendChild(grid);
    box.appendChild(el("p", "small", device.shared
      ? "These are the owner's files. You can open and download them. Your own files are on your device."
      : (device.online
        ? "Live files on this device can be opened now."
        : "This device is off. Live files return when ServerOS is open there. A backup already copied to another device can still be opened.")));
    if ($("openFilesBtn")) $("openFilesBtn").textContent = "Open files on " + device.name;
  }

  function renderCrumbs() {
    var bar = $("crumbs");
    bar.innerHTML = "";
    function addCrumb(label, path) {
      var btn = el("button", "crumb", label);
      btn.type = "button";
      btn.onclick = function () {
        state.path = path;
        loadFiles();
      };
      bar.appendChild(btn);
    }
    addCrumb("Files", "");
    if (!state.path) return;
    var parts = state.path.split("/");
    var acc = "";
    for (var i = 0; i < parts.length; i++) {
      bar.appendChild(document.createTextNode(" / "));
      acc = acc ? acc + "/" + parts[i] : parts[i];
      addCrumb(parts[i], acc);
    }
  }

  function sortedEntries() {
    var items = state.entries.slice();
    var mode = $("sortFiles") ? $("sortFiles").value : "name";
    items.sort(function (a, b) {
      if (a.kind !== b.kind) return a.kind === "folder" ? -1 : 1;
      if (mode === "size") return (b.size || 0) - (a.size || 0);
      if (mode === "new") return (b.modified || 0) - (a.modified || 0);
      var an = a.name.toLowerCase();
      var bn = b.name.toLowerCase();
      if (an < bn) return -1;
      if (an > bn) return 1;
      return 0;
    });
    return items;
  }

  function badgeClass(entry) {
    var kind = badge(entry);
    if (kind === "PDF") return "badge badge-pdf";
    if (kind === "IMG") return "badge badge-img";
    if (kind === "VID" || kind === "AUD") return "badge badge-vid";
    if (kind === "TXT") return "badge badge-txt";
    return "badge";
  }

  function renderFiles() {
    var list = $("fileList");
    var grid = $("folderGrid");
    list.innerHTML = "";
    if (grid) grid.innerHTML = "";
    var query = ($("search").value || "").toLowerCase();
    var items = sortedEntries();
    var fileCount = 0;
    var folderCount = 0;
    for (var i = 0; i < items.length; i++) {
      var entry = items[i];
      if (query && entry.name.toLowerCase().indexOf(query) === -1) continue;
      if (entry.kind === "folder") {
        folderCount += 1;
        if (!grid) continue;
        var tile = el("div", "tile");
        var openFolder = el("button", "file-name");
        openFolder.type = "button";
        openFolder.setAttribute("data-action", "open");
        openFolder.setAttribute("data-path", entry.path);
        openFolder.appendChild(el("span", "folder-ico"));
        var folderText = el("span");
        folderText.appendChild(el("strong", "", entry.name));
        var folderMeta = "Folder";
        if (entry.modified) folderMeta += " · " + formatWhen(entry.modified);
        folderText.appendChild(el("div", "small", folderMeta));
        openFolder.appendChild(folderText);
        tile.appendChild(openFolder);
        if (!selectedDevice() || !selectedDevice().shared) {
          var folderActions = el("div", "tile-actions");
          folderActions.appendChild(actionButton("Rename", "rename", entry.path));
          folderActions.appendChild(actionButton("Delete", "delete", entry.path));
          tile.appendChild(folderActions);
        }
        grid.appendChild(tile);
      } else {
        fileCount += 1;
        var row = el("div", "file");
        var open = el("button", "file-name");
        open.type = "button";
        open.setAttribute("data-action", "open");
        open.setAttribute("data-path", entry.path);
        open.appendChild(el("span", badgeClass(entry), badge(entry)));
        var text = el("span");
        text.appendChild(el("strong", "", entry.name));
        text.appendChild(document.createElement("br"));
        var meta = formatSize(entry.size);
        if (entry.modified) meta += " · " + formatWhen(entry.modified);
        text.appendChild(el("span", "small", meta));
        open.appendChild(text);
        row.appendChild(open);
        var actions = el("div", "file-actions");
        actions.appendChild(actionButton("Download", "download", entry.path));
        if (!selectedDevice() || !selectedDevice().shared) {
          actions.appendChild(actionButton("Share", "share", entry.path));
          actions.appendChild(actionButton("Rename", "rename", entry.path));
          actions.appendChild(actionButton("Delete", "delete", entry.path));
        }
        row.appendChild(actions);
        list.appendChild(row);
        if (grid) {
          var card = el("div", "tile");
          var openCard = el("button", "file-name");
          openCard.type = "button";
          openCard.setAttribute("data-action", "open");
          openCard.setAttribute("data-path", entry.path);
          openCard.appendChild(el("span", "file-ico", badge(entry)));
          var cardText = el("span");
          cardText.appendChild(el("strong", "", entry.name));
          cardText.appendChild(el("div", "small", formatSize(entry.size)));
          openCard.appendChild(cardText);
          card.appendChild(openCard);
          grid.appendChild(card);
        }
      }
    }
    if (!fileCount) {
      list.appendChild(el("p", "empty", query ? "No file matches that search." : "No files in this folder yet."));
    }
    if (grid && !folderCount && !fileCount) {
      grid.appendChild(el("p", "empty", query ? "Nothing in this folder matches that search." : "This folder is empty. Upload a file or add a folder."));
    }
  }

  function actionButton(label, action, path) {
    var btn = el("button", "btn secondary", label);
    btn.type = "button";
    btn.setAttribute("data-action", action);
    btn.setAttribute("data-path", path);
    return btn;
  }

  function updateHeading() {
    var device = selectedDevice();
    $("filesTitle").textContent = device ? "Files on " + device.name : "Files";
    $("upBtn").disabled = !state.path;
    if (!device) {
      $("filesNote").textContent = "";
      return;
    }
    if (device.shared) {
      $("filesNote").textContent = "These are the owner's files. You can open and download them. Switch to your device to see your own files.";
    } else if (!device.online) {
      $("filesNote").textContent = device.name + " is off right now. Files stored there come back when that device is on and ServerOS is open.";
    } else if (device.role === "home") {
      $("filesNote").textContent = "New files are saved on this device.";
    } else {
      $("filesNote").textContent = "New files are saved on " + device.name + " while it is online.";
    }
    if (device.role === "home" || device.shared) $("removeDeviceBtn").classList.add("hidden");
    else $("removeDeviceBtn").classList.remove("hidden");
    if (device.shared) $("renameDeviceBtn").classList.add("hidden");
    else $("renameDeviceBtn").classList.remove("hidden");
    var writeBits = ["dropZone", "newFolderBtn", "newNoteBtn"];
    for (var w = 0; w < writeBits.length; w++) {
      if (!$(writeBits[w])) continue;
      if (device.shared) $(writeBits[w]).classList.add("hidden");
      else $(writeBits[w]).classList.remove("hidden");
    }
  }

  function loadFiles() {
    renderCrumbs();
    updateHeading();
    var device = selectedDevice();
    if (!device) return;
    if (!device.online) {
      state.entries = [];
      $("fileList").innerHTML = "";
      $("fileList").appendChild(el("p", "empty", device.name + " is off right now. Turn it on and leave ServerOS open there."));
      if ($("folderGrid")) {
        $("folderGrid").innerHTML = "";
        $("folderGrid").appendChild(el("p", "empty", "Files on " + device.name + " come back when that device is on."));
      }
      return;
    }
    var url = "/api/files?deviceId=" + encodeURIComponent(device.id) + "&path=" + encodeURIComponent(state.path);
    api("GET", url, null, function (err, data) {
      if (err) {
        if (err.status === 401) { showAuth("loginPanel"); stopPoll(); return; }
        toast(err.message, true);
        return;
      }
      state.entries = data.entries || [];
      renderFiles();
    });
  }

  function refreshDevices(done, quiet) {
    api("GET", "/api/devices", null, function (err, data) {
      if (err) {
        if (err.status === 401) { showAuth("loginPanel"); stopPoll(); return; }
        if (!quiet) toast(err.message, true);
        return;
      }
      state.devices = data.devices || [];
      var found = false;
      for (var i = 0; i < state.devices.length; i++) {
        if (state.devices[i].id === state.deviceId) found = true;
      }
      if (!found) {
        state.deviceId = "";
        state.path = "";
        for (var j = 0; j < state.devices.length; j++) {
          if (state.devices[j].role === "home") state.deviceId = state.devices[j].id;
        }
        if (!state.deviceId && state.devices.length) state.deviceId = state.devices[0].id;
      }
      renderDevices();
      if (done) done();
      else updateHeading();
    });
  }

  function startPoll() {
    stopPoll();
    pollTimer = setInterval(function () {
      var before = "";
      var device = selectedDevice();
      if (device) before = device.online ? "1" : "0";
      refreshDevices(function () {
        var now = selectedDevice();
        var after = now && now.online ? "1" : "0";
        if (before !== after) loadFiles();
      }, true);
    }, 8000);
  }

  function loadConnect() {
    api("GET", "/api/connect-info", null, function (err, data) {
      if (err) return;
      $("connectPrimary").textContent = data.primary || data.localhost;
      $("connectPrimary").setAttribute("data-url", data.primary || data.localhost);
      var list = $("urlList");
      list.innerHTML = "";
      var urls = data.urls || [];
      for (var i = 0; i < urls.length; i++) {
        if (urls[i] === data.primary) continue;
        list.appendChild(el("p", "small", urls[i]));
      }
      if (data.qr) {
        $("qrImage").src = data.qr;
        $("qrImage").classList.remove("hidden");
      }
      $("connectNote").textContent = urls.length
        ? "Same Wi-Fi works with no extra setup. From outside your home, the router must forward port " + data.port + " to this device, and this device must stay on."
        : "Connect this device to Wi-Fi so phones can reach it.";
    });
  }

  var backupTimer = null;
  var backupDevice = "";
  var backupPath = "";

  function formatSaved(status) {
    if (!status || !status.originalBytes) return "";
    var saved = status.originalBytes - status.storedBytes;
    if (saved < 0) saved = 0;
    return "Original " + formatSize(status.originalBytes) + ", backup " + formatSize(status.storedBytes) + " (saved " + formatSize(saved) + ").";
  }

  function paintBackupStatus(status) {
    if (!status) return;
    $("backupScope").textContent = status.scope || "";
    if (status.android && !status.androidReady) $("backupAndroid").classList.remove("hidden");
    else $("backupAndroid").classList.add("hidden");
    if (status.consent) {
      $("backupAllow").classList.add("hidden");
      $("backupStart").classList.remove("hidden");
    } else {
      $("backupAllow").classList.remove("hidden");
      $("backupStart").classList.add("hidden");
    }
    var text = "";
    if (status.running) {
      $("backupProgressWrap").classList.remove("hidden");
      var pct = status.total ? Math.round((status.done / status.total) * 100) : 0;
      $("backupProgressBar").style.width = pct + "%";
      text = (status.phase === "copying" ? "Copying to your other devices. " : "Backing up " + status.done + " of " + status.total + ". ") + (status.current || "");
    } else {
      $("backupProgressWrap").classList.add("hidden");
      if (status.phase === "done" || status.lastRun) text = "Backup saved. " + formatSaved(status);
      if (status.copiedToOthers) text += " A copy was sent to your main ServerOS.";
      else if (status.consent && status.lastRun && status.role === "linked") text += " The main ServerOS was not reachable. Leave it on, then back up again.";
      else if (status.consent && status.lastRun) text += " A device that stays on keeps a copy you can open when this one is off.";
    }
    $("backupProgress").textContent = text;
    $("backupError").textContent = status.error || "";
    $("backupStart").disabled = !!status.running;
  }

  function setNav(id) {
    var ids = ["navDash", "navFiles", "backupBtn", "accountBtn"];
    for (var i = 0; i < ids.length; i++) {
      var node = $(ids[i]);
      if (!node) continue;
      if (ids[i] === id) node.classList.add("nav-on");
      else node.classList.remove("nav-on");
    }
  }

  function showDashView() {
    $("dashView").classList.remove("hidden");
    $("filesView").classList.add("hidden");
    $("backupView").classList.add("hidden");
    setNav("navDash");
    if (backupTimer) clearInterval(backupTimer);
    backupTimer = null;
  }

  function showBackupView() {
    $("dashView").classList.add("hidden");
    $("filesView").classList.add("hidden");
    $("backupView").classList.remove("hidden");
    setNav("backupBtn");
    loadBackup();
    if (backupTimer) clearInterval(backupTimer);
    backupTimer = setInterval(loadBackup, 2000);
  }

  function showFilesView() {
    $("dashView").classList.add("hidden");
    $("backupView").classList.add("hidden");
    $("filesView").classList.remove("hidden");
    setNav("navFiles");
    if (backupTimer) clearInterval(backupTimer);
    backupTimer = null;
  }

  function loadBackup() {
    api("GET", "/api/backup/status", null, function (err, status) {
      if (err) return;
      paintBackupStatus(status);
      if (!status.running && backupTimer && status.phase === "done") {
        clearInterval(backupTimer);
        backupTimer = null;
      }
    });
    api("GET", "/api/backup/library", null, function (err, data) {
      if (err) return;
      var box = $("backupList");
      box.innerHTML = "";
      var items = (data && data.backups) || [];
      if (!items.length) {
        box.appendChild(el("p", "small", "No backup is stored on this device yet."));
        return;
      }
      for (var i = 0; i < items.length; i++) {
        (function (item) {
          var btn = el("button", "device", item.deviceName);
          btn.type = "button";
          btn.appendChild(el("span", "small", (item.fileCount || 0) + " files · backup " + formatSize(item.storedBytes) + " · original " + formatSize(item.originalBytes)));
          btn.onclick = function () {
            backupDevice = item.deviceId;
            backupPath = "";
            loadBackupFiles();
          };
          box.appendChild(btn);
        })(items[i]);
      }
    });
  }

  function loadBackupFiles() {
    if (!backupDevice) return;
    api("GET", "/api/backup/files?deviceId=" + encodeURIComponent(backupDevice) + "&path=" + encodeURIComponent(backupPath), null, function (err, data) {
      if (err) { toast(err.message, true); return; }
      var crumbs = $("backupCrumbs");
      crumbs.innerHTML = "";
      var home = el("button", "crumb", data.deviceName || "Backup");
      home.type = "button";
      home.onclick = function () { backupPath = ""; loadBackupFiles(); };
      crumbs.appendChild(home);
      if (backupPath) {
        var parts = backupPath.split("/");
        var acc = "";
        for (var p = 0; p < parts.length; p++) {
          crumbs.appendChild(document.createTextNode(" / "));
          acc = acc ? acc + "/" + parts[p] : parts[p];
          (function (path) {
            var btn = el("button", "crumb", path.split("/").pop());
            btn.type = "button";
            btn.onclick = function () { backupPath = path; loadBackupFiles(); };
            crumbs.appendChild(btn);
          })(acc);
        }
      }
      var list = $("backupFiles");
      list.innerHTML = "";
      var folders = data.folders || [];
      for (var i = 0; i < folders.length; i++) {
        (function (name) {
          var row = el("button", "file-name", "");
          row.type = "button";
          row.appendChild(el("span", "badge", "DIR"));
          row.appendChild(el("strong", "", name));
          row.onclick = function () {
            backupPath = backupPath ? backupPath + "/" + name : name;
            loadBackupFiles();
          };
          var wrap = el("div", "file");
          wrap.appendChild(row);
          list.appendChild(wrap);
        })(folders[i]);
      }
      var files = data.files || [];
      for (var f = 0; f < files.length; f++) {
        (function (file) {
          var wrap = el("div", "file");
          var name = el("div", "file-name");
          name.appendChild(el("span", "badge", "FILE"));
          var text = el("span");
          text.appendChild(el("strong", "", file.path.split("/").pop()));
          text.appendChild(el("div", "small", formatSize(file.size) + " stored as " + formatSize(file.stored)));
          name.appendChild(text);
          wrap.appendChild(name);
          var dl = el("a", "btn secondary", "Download");
          dl.href = "/api/backup/download?deviceId=" + encodeURIComponent(backupDevice) + "&id=" + encodeURIComponent(file.id);
          wrap.appendChild(dl);
          list.appendChild(wrap);
        })(files[f]);
      }
      if (!folders.length && !files.length) list.appendChild(el("p", "empty", "This backup folder is empty."));
    });
  }

  function paintNodeBackup(status) {
    if (!$("nodeBackupText")) return;
    if (status.consent) {
      $("nodeBackupAllow").classList.add("hidden");
      $("nodeBackupStart").classList.remove("hidden");
    }
    if (status.android && !status.androidReady) $("nodeBackupAndroid").classList.remove("hidden");
    var line = status.scope || "";
    if (status.running) line = "Backing up " + status.done + " of " + status.total + ".";
    else if (status.lastRun) line = "Last backup saved. " + formatSaved(status);
    if (status.error) line = status.error;
    $("nodeBackupProgress").textContent = line;
  }

  function loadNodeBackup() {
    api("GET", "/api/backup/status", null, function (err, status) {
      if (!err) paintNodeBackup(status);
    });
    api("GET", "/api/backup/library", null, function (err, data) {
      if (err || !$("nodeBackupList")) return;
      var box = $("nodeBackupList");
      box.innerHTML = "";
      var items = (data && data.backups) || [];
      for (var i = 0; i < items.length; i++) {
        box.appendChild(el("p", "small", items[i].deviceName + " · " + (items[i].fileCount || 0) + " files · " + formatSize(items[i].storedBytes)));
      }
      if (!items.length) box.appendChild(el("p", "small", "No saved backup on this device yet."));
    });
  }

  function enterApp() {
    stopSetupPoll();
    stopNodePoll();
    show("appScreen");
    $("whoami").textContent = state.user ? state.user.username : "";
    renderBanner();
    loadConnect();
    refreshDevices(function () { loadFiles(); });
    startPoll();
    if (state.backup && state.backup.consent !== true) showBackupView();
    else showDashView();
  }

  function renderNode(node) {
    $("nodeName").textContent = node.deviceName || "This device";
    $("nodeStatus").textContent = node.online ? "Online" : "Not connected";
    $("nodeStatus").className = "status-pill " + (node.online ? "online" : "offline");
    $("nodeHome").textContent = node.homeUrl || "";
    $("openHome").setAttribute("href", node.homeUrl || "#");
    $("nodeError").textContent = node.lastError || "";
    $("nodeUser").textContent = node.username ? "Signed in as " + node.username : "";
    if (!$("rejoinHome").value && node.homeUrl) $("rejoinHome").value = node.homeUrl;
    if (!$("rejoinLogin").value && node.username) $("rejoinLogin").value = node.username;
    if (!$("rejoinDevice").value && node.deviceName) $("rejoinDevice").value = node.deviceName;
    loadNodeBackup();
  }

  function applyBootstrap(data) {
    state.mode = data.mode;
    state.user = data.user;
    state.onThisDevice = !!data.onThisDevice;
    state.accountExists = !!data.accountExists;
    state.needsOwnerCode = !!data.needsOwnerCode;
    state.backup = data.backup || null;
    if (data.ownerCode) {
      $("ownerCode").textContent = data.ownerCode;
      $("ownerBox").classList.remove("hidden");
    } else $("ownerBox").classList.add("hidden");
    if (data.needsOwnerCode) $("regOwnerWrap").classList.remove("hidden");
    else $("regOwnerWrap").classList.add("hidden");
    if (!$("regDevice").value && data.suggestedName) $("regDevice").value = data.suggestedName;
    if (!$("joinDevice").value && data.suggestedName) $("joinDevice").value = data.suggestedName;
    if (data.onThisDevice && data.accountExists) $("openLocalReset").classList.remove("hidden");
    else $("openLocalReset").classList.add("hidden");
    if (data.mode === "linked") {
      stopPoll();
      stopSetupPoll();
      show("nodeScreen");
      renderNode(data.node || {});
      startNodePoll();
      return;
    }
    stopNodePoll();
    if (data.user) {
      enterApp();
      return;
    }
    stopPoll();
    if (data.accountExists) {
      stopSetupPoll();
      showAuth("loginPanel");
      return;
    }
    show("setupScreen");
    startSetupPoll();
  }

  function openModal(title, node, actions, locked) {
    $("modalTitle").textContent = title;
    var body = $("modalBody");
    body.innerHTML = "";
    if (node) body.appendChild(node);
    var bar = $("modalActions");
    bar.innerHTML = "";
    for (var i = 0; i < (actions || []).length; i++) bar.appendChild(actions[i]);
    $("modal").setAttribute("data-locked", locked ? "1" : "0");
    $("modal").classList.remove("hidden");
  }

  function closeModal() {
    $("modal").classList.add("hidden");
    $("modal").setAttribute("data-locked", "0");
    $("modalBody").innerHTML = "";
    $("modalActions").innerHTML = "";
  }

  function button(label, className, fn) {
    var btn = el("button", className || "btn secondary", label);
    btn.type = "button";
    btn.onclick = fn;
    return btn;
  }

  function findEntry(path) {
    for (var i = 0; i < state.entries.length; i++) {
      if (state.entries[i].path === path) return state.entries[i];
    }
    return null;
  }

  function downloadUrl(entry, inline) {
    return "/api/download?deviceId=" + encodeURIComponent(state.deviceId) +
      "&path=" + encodeURIComponent(entry.path) + (inline ? "&inline=1" : "");
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () {
        toast("Copied.");
      }, function () { fallbackCopy(text); });
      return;
    }
    fallbackCopy(text);
  }

  function fallbackCopy(text) {
    var area = document.createElement("textarea");
    area.value = text;
    document.body.appendChild(area);
    area.select();
    try {
      document.execCommand("copy");
      toast("Copied.");
    } catch (e) {
      toast("Could not copy. Select the address and copy it yourself.", true);
    }
    document.body.removeChild(area);
  }

  function showRecovery(key, done) {
    var wrap = el("div");
    wrap.appendChild(el("p", "", "Save this recovery key. It is the only way to reset your password from another device."));
    var input = el("input", "field");
    input.value = key;
    input.readOnly = true;
    wrap.appendChild(input);
    var label = el("label", "check");
    var box = document.createElement("input");
    box.type = "checkbox";
    label.appendChild(box);
    label.appendChild(document.createTextNode("I have saved this key somewhere safe."));
    wrap.appendChild(label);
    var next = button("Continue", "btn primary", function () {
      if (!box.checked) {
        toast("Tick the box after you save the key.", true);
        return;
      }
      closeModal();
      if (done) done();
    });
    var copy = button("Copy key", "btn secondary", function () { copyText(key); });
    openModal("Save your recovery key", wrap, [copy, next], true);
  }

  function requireMine() {
    var device = requireOnline();
    if (!device) return null;
    if (device.shared) {
      toast("Those files belong to the owner. Open your own device to add files.", true);
      return null;
    }
    return device;
  }

  function uploadFiles(fileList) {
    if (state.uploading) return;
    var device = requireMine();
    if (!device) return;
    var files = [];
    for (var i = 0; i < fileList.length; i++) files.push(fileList[i]);
    if (!files.length) return;
    if (typeof FormData === "undefined") {
      toast("This browser cannot upload files. Try Chrome or Firefox.", true);
      return;
    }
    state.uploading = true;
    $("progressWrap").classList.remove("hidden");
    var index = 0;
    function next() {
      if (index >= files.length) {
        state.uploading = false;
        $("progressWrap").classList.add("hidden");
        $("progressBar").style.width = "0%";
        toast(files.length === 1 ? "Upload finished." : "Uploads finished.");
        loadFiles();
        refreshDevices();
        return;
      }
      var file = files[index];
      index += 1;
      var fd = new FormData();
      fd.append("deviceId", state.deviceId);
      fd.append("path", state.path);
      try { fd.append("files", file, file.name); }
      catch (ignore) { fd.append("files", file); }
      fd.append("relpaths", file.webkitRelativePath || file.name);
      var xhr = new XMLHttpRequest();
      xhr.open("POST", "/api/upload", true);
      xhr.timeout = 0;
      if (xhr.upload) xhr.upload.onprogress = function (e) {
        if (!e.lengthComputable) return;
        var pct = Math.round((e.loaded / e.total) * 100);
        $("progressBar").style.width = pct + "%";
        $("progressLabel").textContent = "Uploading " + index + " of " + files.length + ": " + file.name;
      };
      xhr.onreadystatechange = function () {
        if (xhr.readyState !== 4) return;
        if (xhr.status >= 200 && xhr.status < 300) next();
        else {
          var data = {};
          try { data = JSON.parse(xhr.responseText || "{}"); } catch (e) {}
          state.uploading = false;
          $("progressWrap").classList.add("hidden");
          toast(data.error || "Upload failed.", true);
          loadFiles();
        }
      };
      xhr.onerror = function () {
        state.uploading = false;
        $("progressWrap").classList.add("hidden");
        toast("Upload failed. Check that the device is still on.", true);
      };
      xhr.send(fd);
    }
    next();
  }

  function openPreview(entry) {
    var ext = extOf(entry.name);
    var wrap = el("div");
    var url = downloadUrl(entry, true);
    if (ext === "png" || ext === "jpg" || ext === "jpeg" || ext === "gif" || ext === "webp") {
      var img = el("img", "preview-media");
      img.alt = entry.name;
      img.src = url;
      wrap.appendChild(img);
      openModal(entry.name, wrap, [button("Close", "btn secondary", closeModal)], false);
      return;
    }
    if (ext === "mp3" || ext === "wav" || ext === "m4a" || ext === "ogg") {
      var audio = el("audio", "preview-media");
      audio.controls = true;
      audio.src = url;
      wrap.appendChild(audio);
      openModal(entry.name, wrap, [button("Close", "btn secondary", closeModal)], false);
      return;
    }
    if (ext === "mp4" || ext === "webm") {
      var video = el("video", "preview-media");
      video.controls = true;
      video.src = url;
      wrap.appendChild(video);
      openModal(entry.name, wrap, [button("Close", "btn secondary", closeModal)], false);
      return;
    }
    if (ext === "pdf") {
      var frame = el("iframe", "preview-media");
      frame.src = url;
      frame.style.width = "100%";
      frame.style.height = "60vh";
      wrap.appendChild(frame);
      openModal(entry.name, wrap, [button("Close", "btn secondary", closeModal)], false);
      return;
    }
    if (ext === "txt" || ext === "md" || ext === "log" || ext === "csv" || ext === "json") {
      if (entry.size > 300000) {
        toast("That note is large. Download it to read it.", true);
        return;
      }
      var xhr = new XMLHttpRequest();
      xhr.open("GET", url, true);
      xhr.onreadystatechange = function () {
        if (xhr.readyState !== 4) return;
        if (xhr.status < 200 || xhr.status >= 300) {
          toast("Could not open that file.", true);
          return;
        }
        var pre = el("pre", "preview-text", xhr.responseText);
        wrap.appendChild(pre);
        openModal(entry.name, wrap, [button("Close", "btn secondary", closeModal)], false);
      };
      xhr.send();
      return;
    }
    window.location.href = downloadUrl(entry, false);
  }

  function askText(title, label, value, onOk) {
    var wrap = el("div");
    var input = el("input", "field");
    input.value = value || "";
    var lab = el("label", "stack");
    lab.appendChild(el("span", "eyebrow", label));
    lab.appendChild(input);
    wrap.appendChild(lab);
    openModal(title, wrap, [
      button("Cancel", "btn secondary", closeModal),
      button("Save", "btn primary", function () { onOk(input.value); })
    ], false);
    input.focus();
  }

  function openAccount() {
    api("GET", "/api/shares", null, function (err, data) {
      if (err) { toast(err.message, true); return; }
      var wrap = el("div");
      wrap.appendChild(el("p", "", "Signed in as " + (state.user ? state.user.username : "") + (state.user && state.user.email ? " · " + state.user.email : "")));
      var current = el("input", "field");
      current.type = "password";
      current.autocomplete = "current-password";
      var newer = el("input", "field");
      newer.type = "password";
      newer.autocomplete = "new-password";
      var again = el("input", "field");
      again.type = "password";
      again.autocomplete = "new-password";
      function labeled(text, input) {
        var lab = el("label", "stack");
        lab.appendChild(el("span", "eyebrow", text));
        lab.appendChild(input);
        return lab;
      }
      wrap.appendChild(el("h2", "section-title", "Change password"));
      wrap.appendChild(labeled("Current password", current));
      wrap.appendChild(labeled("New password", newer));
      wrap.appendChild(labeled("Confirm new password", again));
      wrap.appendChild(button("Save password", "btn secondary", function () {
        api("POST", "/api/password", {
          currentPassword: current.value,
          password: newer.value,
          confirmPassword: again.value
        }, function (saveErr, saveData) {
          if (saveErr) { toast(saveErr.message, true); return; }
          toast(saveData.message || "Password saved.");
          current.value = "";
          newer.value = "";
          again.value = "";
        });
      }));
      wrap.appendChild(button("Create a new recovery key", "btn ghost", function () {
        api("POST", "/api/recovery/rotate", { currentPassword: current.value }, function (keyErr, keyData) {
          if (keyErr) { toast(keyErr.message, true); return; }
          showRecovery(keyData.recoveryKey);
        });
      }));
      wrap.appendChild(el("h2", "section-title", "Shared links"));
      var shares = (data && data.shares) || [];
      if (!shares.length) wrap.appendChild(el("p", "small", "No shared links yet."));
      for (var i = 0; i < shares.length; i++) {
        (function (share) {
          var row = el("div", "share-row");
          row.appendChild(el("strong", "", share.name));
          row.appendChild(el("div", "small", share.deviceName + " · until " + formatWhen(share.expiresAt)));
          row.appendChild(el("div", "small", share.url));
          row.appendChild(button("Copy", "btn secondary", function () { copyText(share.url); }));
          row.appendChild(button("Stop sharing", "btn ghost", function () {
            api("POST", "/api/shares/revoke", { token: share.token }, function (revErr) {
              if (revErr) { toast(revErr.message, true); return; }
              closeModal();
              openAccount();
            });
          }));
          wrap.appendChild(row);
        })(shares[i]);
      }
      openModal("Account", wrap, [button("Close", "btn primary", closeModal)], false);
    });
  }

  function onFileAction(action, path) {
    var entry = findEntry(path);
    if (!entry) return;
    if (action === "open") {
      if (entry.kind === "folder") {
        state.path = entry.path;
        loadFiles();
      } else openPreview(entry);
      return;
    }
    if (action === "download") {
      window.location.href = downloadUrl(entry, false);
      return;
    }
    if (action === "rename") {
      askText("Rename", "New name", entry.name, function (name) {
        api("POST", "/api/rename", { deviceId: state.deviceId, path: entry.path, name: name }, function (err) {
          if (err) { toast(err.message, true); return; }
          closeModal();
          loadFiles();
        });
      });
      return;
    }
    if (action === "delete") {
      var wrap = el("div");
      wrap.appendChild(el("p", "", entry.kind === "folder"
        ? "Delete this folder and everything inside it?"
        : "Delete this file?"));
      openModal("Delete " + entry.name, wrap, [
        button("Cancel", "btn secondary", closeModal),
        button("Delete", "btn danger", function () {
          api("POST", "/api/delete", { deviceId: state.deviceId, path: entry.path }, function (err) {
            if (err) { toast(err.message, true); return; }
            closeModal();
            loadFiles();
            refreshDevices();
          });
        })
      ], false);
      return;
    }
    if (action === "share") {
      var box = el("div");
      box.appendChild(el("p", "", "Anyone with the link can download this file until it expires. The device storing it must stay on."));
      function make(hours, label) {
        return button(label, "btn secondary", function () {
          api("POST", "/api/share", { deviceId: state.deviceId, path: entry.path, hours: hours }, function (err, data) {
            if (err) { toast(err.message, true); return; }
            var done = el("div");
            done.appendChild(el("p", "", "Link ready. It stops working " + formatWhen(data.expiresAt) + "."));
            var input = el("input", "field");
            input.readOnly = true;
            input.value = data.url;
            done.appendChild(input);
            openModal("Share " + entry.name, done, [
              button("Copy link", "btn secondary", function () { copyText(data.url); }),
              button("Close", "btn primary", closeModal)
            ], false);
          });
        });
      }
      openModal("Share " + entry.name, box, [
        make(1, "1 hour"),
        make(24, "1 day"),
        make(168, "7 days"),
        button("Cancel", "btn ghost", closeModal)
      ], false);
    }
  }

  function setBusy(buttonNode, busy, busyLabel, idleLabel) {
    buttonNode.disabled = busy;
    buttonNode.textContent = busy ? busyLabel : idleLabel;
  }

  function creditLine() {
    var codes = [67,111,112,121,114,105,103,104,116,44,32,68,101,118,101,108,111,112,101,114,32,64,32,82,32,82,97,106,107,117,109,97,114,32,80,97,100,109,97,110,97,98,104,97,110];
    var text = "";
    for (var i = 0; i < codes.length; i++) text += String.fromCharCode(codes[i]);
    return text;
  }

  function keepCredit() {
    var text = creditLine();
    var shown = "";
    try { shown = window.getComputedStyle(document.body, "::after").content || ""; } catch (err) { shown = ""; }
    shown = String(shown).replace(/^"|"$/g, "");
    var bar = document.getElementById("edgebar");
    if (shown === text) {
      if (bar && bar.parentNode) bar.parentNode.removeChild(bar);
      return;
    }
    if (!bar) {
      bar = document.createElement("div");
      bar.id = "edgebar";
      document.body.appendChild(bar);
    }
    if (bar.textContent !== text) bar.textContent = text;
    if (bar.parentNode !== document.body) document.body.appendChild(bar);
  }

  function boot() {
    keepCredit();
    setInterval(keepCredit, 1500);
    if (window.MutationObserver) {
      var watch = new MutationObserver(keepCredit);
      watch.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
    }
    var helps = document.querySelectorAll(".js-help");
    for (var h = 0; h < helps.length; h++) {
      helps[h].addEventListener("click", function () {
        $("helpModal").classList.remove("hidden");
      });
    }
    var backs = document.querySelectorAll(".js-back-login");
    for (var b = 0; b < backs.length; b++) {
      backs[b].addEventListener("click", function () { showAuth("loginPanel"); });
    }
    var closers = document.querySelectorAll(".js-close-help");
    for (var c = 0; c < closers.length; c++) {
      closers[c].addEventListener("click", function () { $("helpModal").classList.add("hidden"); });
    }
    $("helpModal").addEventListener("click", function (e) {
      if (e.target === $("helpModal")) $("helpModal").classList.add("hidden");
    });
    $("modal").addEventListener("click", function (e) {
      if (e.target === $("modal") && $("modal").getAttribute("data-locked") !== "1") closeModal();
    });
    document.addEventListener("keydown", function (e) {
      var key = e.key || e.keyCode;
      if (key !== "Escape" && key !== 27) return;
      if ($("helpModal").className.indexOf("hidden") === -1) $("helpModal").classList.add("hidden");
      if ($("modal").className.indexOf("hidden") === -1 && $("modal").getAttribute("data-locked") !== "1") closeModal();
    });

    $("beHome").addEventListener("click", function () { showAuth("registerPanel"); });
    $("beNode").addEventListener("click", function () { $("joinForm").classList.remove("hidden"); });
    $("backSetup").addEventListener("click", function () { show("setupScreen"); });
    $("goRegister").addEventListener("click", function () { showAuth("registerPanel"); });
    $("goLogin").addEventListener("click", function () { showAuth("loginPanel"); });
    var eyes = document.querySelectorAll(".js-eye");
    for (var eye = 0; eye < eyes.length; eye++) {
      eyes[eye].addEventListener("click", function () {
        var input = $(this.getAttribute("data-target"));
        if (!input) return;
        var hidden = input.type === "password";
        input.type = hidden ? "text" : "password";
        this.textContent = hidden ? "Hide" : "Show";
      });
    }
    $("openRecover").addEventListener("click", function () { showAuth("recoverPanel"); });
    $("openLocalReset").addEventListener("click", function () { showAuth("localPanel"); });

    $("joinForm").addEventListener("submit", function (e) {
      e.preventDefault();
      $("joinError").textContent = "";
      var submit = $("joinForm").querySelector("button[type=submit]");
      setBusy(submit, true, "Connecting…", "Connect this device");
      api("POST", "/api/setup/join", {
        homeUrl: $("joinHome").value,
        login: $("joinLogin").value,
        password: $("joinPassword").value,
        deviceName: $("joinDevice").value
      }, function (err) {
        setBusy(submit, false, "Connecting…", "Connect this device");
        if (err) { $("joinError").textContent = err.message; return; }
        api("GET", "/api/bootstrap", null, function (bootErr, data) {
          if (bootErr) { toast(bootErr.message, true); return; }
          applyBootstrap(data);
        });
      });
    });

    $("rejoinForm").addEventListener("submit", function (e) {
      e.preventDefault();
      $("rejoinError").textContent = "";
      api("POST", "/api/setup/join", {
        homeUrl: $("rejoinHome").value,
        login: $("rejoinLogin").value,
        password: $("rejoinPassword").value,
        deviceName: $("rejoinDevice").value
      }, function (err) {
        if (err) { $("rejoinError").textContent = err.message; return; }
        $("rejoinPassword").value = "";
        toast("This device is connected.");
        api("GET", "/api/bootstrap", null, function (bootErr, data) {
          if (!bootErr && data) applyBootstrap(data);
        });
      });
    });

    $("loginForm").addEventListener("submit", function (e) {
      e.preventDefault();
      $("loginError").textContent = "";
      api("POST", "/api/login", {
        login: $("loginId").value,
        password: $("loginPassword").value
      }, function (err, data) {
        if (err) { $("loginError").textContent = err.message; return; }
        state.user = data.user;
        enterApp();
      });
    });

    $("registerForm").addEventListener("submit", function (e) {
      e.preventDefault();
      $("regError").textContent = "";
      api("POST", "/api/register", {
        username: $("regUsername").value,
        email: $("regEmail").value,
        password: $("regPassword").value,
        confirmPassword: $("regPassword2").value,
        deviceName: $("regDevice").value,
        ownerCode: $("regOwnerCode").value
      }, function (err, data) {
        if (err) { $("regError").textContent = err.message; return; }
        state.user = data.user;
        state.accountExists = true;
        if (data.recoveryKey) showRecovery(data.recoveryKey, enterApp);
        else enterApp();
      });
    });

    $("recoverForm").addEventListener("submit", function (e) {
      e.preventDefault();
      $("recoverError").textContent = "";
      api("POST", "/api/recover", {
        login: $("recoverLogin").value,
        recoveryKey: $("recoverKey").value,
        password: $("recoverPassword").value,
        confirmPassword: $("recoverPassword2").value
      }, function (err) {
        if (err) { $("recoverError").textContent = err.message; return; }
        toast("Password saved. Log in with the new one.");
        showAuth("loginPanel");
      });
    });

    $("localForm").addEventListener("submit", function (e) {
      e.preventDefault();
      $("localError").textContent = "";
      api("POST", "/api/password/local-reset", {
        password: $("localPassword").value,
        confirmPassword: $("localPassword2").value
      }, function (err) {
        if (err) { $("localError").textContent = err.message; return; }
        toast("Password saved. Log in with the new one.");
        showAuth("loginPanel");
      });
    });

    $("logoutBtn").addEventListener("click", function () {
      api("POST", "/api/logout", {}, function () {
        stopPoll();
        state.user = null;
        state.devices = [];
        showAuth("loginPanel");
      });
    });
    $("navDash").addEventListener("click", showDashView);
    $("navFiles").addEventListener("click", function () {
      showFilesView();
      loadFiles();
    });
    $("openFilesBtn").addEventListener("click", function () {
      showFilesView();
      loadFiles();
    });
    $("sortFiles").addEventListener("change", renderFiles);
    $("backupBtn").addEventListener("click", showBackupView);
    $("backupBack").addEventListener("click", showFilesView);
    $("backupAllow").addEventListener("click", function () {
      api("POST", "/api/backup/consent", { allow: true }, function (err) {
        if (err) { toast(err.message, true); return; }
        api("POST", "/api/backup/start", {}, function (startErr, status) {
          if (startErr) { toast(startErr.message, true); return; }
          paintBackupStatus(status);
          showBackupView();
        });
      });
    });
    $("backupStart").addEventListener("click", function () {
      api("POST", "/api/backup/start", {}, function (err, status) {
        if (err) { toast(err.message, true); return; }
        paintBackupStatus(status);
        showBackupView();
      });
    });
    $("backupAndroid").addEventListener("click", function () {
      api("POST", "/api/backup/android-permission", {}, function (err, data) {
        toast((data && data.message) || (err && err.message) || "Check the phone for an Allow prompt.");
      });
    });
    if ($("nodeBackupAllow")) {
      $("nodeBackupAllow").addEventListener("click", function () {
        api("POST", "/api/backup/consent", { allow: true }, function (err) {
          if (err) { toast(err.message, true); return; }
          api("POST", "/api/backup/start", {}, function (startErr) {
            if (startErr) toast(startErr.message, true);
            loadNodeBackup();
          });
        });
      });
    }
    if ($("nodeBackupStart")) {
      $("nodeBackupStart").addEventListener("click", function () {
        api("POST", "/api/backup/start", {}, function (err) {
          if (err) toast(err.message, true);
          loadNodeBackup();
        });
      });
    }
    if ($("nodeBackupAndroid")) {
      $("nodeBackupAndroid").addEventListener("click", function () {
        api("POST", "/api/backup/android-permission", {}, function (err, data) {
          toast((data && data.message) || (err && err.message) || "Tap Allow if Android asks.");
        });
      });
    }
    $("accountBtn").addEventListener("click", openAccount);
    $("copyLink").addEventListener("click", function () {
      copyText($("connectPrimary").getAttribute("data-url") || $("connectPrimary").textContent);
    });
    $("refreshBtn").addEventListener("click", function () {
      refreshDevices(function () { loadFiles(); });
    });
    $("upBtn").addEventListener("click", function () {
      if (!state.path) return;
      var slash = state.path.lastIndexOf("/");
      state.path = slash === -1 ? "" : state.path.slice(0, slash);
      loadFiles();
    });
    $("search").addEventListener("input", renderFiles);
    $("fileInput").addEventListener("change", function () {
      uploadFiles($("fileInput").files);
      $("fileInput").value = "";
    });
    $("folderInput").addEventListener("change", function () {
      uploadFiles($("folderInput").files);
      $("folderInput").value = "";
    });
    $("newFolderBtn").addEventListener("click", function () {
      if (!requireMine()) return;
      askText("New folder", "Folder name", "", function (name) {
        api("POST", "/api/folder", { deviceId: state.deviceId, path: state.path, name: name }, function (err) {
          if (err) { toast(err.message, true); return; }
          closeModal();
          loadFiles();
        });
      });
    });
    $("newNoteBtn").addEventListener("click", function () {
      if (!requireMine()) return;
      var wrap = el("div");
      var name = el("input", "field");
      name.value = "Note";
      var body = el("textarea", "field");
      var nameLab = el("label", "stack");
      nameLab.appendChild(el("span", "eyebrow", "Name"));
      nameLab.appendChild(name);
      var bodyLab = el("label", "stack");
      bodyLab.appendChild(el("span", "eyebrow", "Note"));
      bodyLab.appendChild(body);
      wrap.appendChild(nameLab);
      wrap.appendChild(bodyLab);
      openModal("New note", wrap, [
        button("Cancel", "btn secondary", closeModal),
        button("Save", "btn primary", function () {
          api("POST", "/api/note", {
            deviceId: state.deviceId,
            path: state.path,
            name: name.value,
            content: body.value
          }, function (err) {
            if (err) { toast(err.message, true); return; }
            closeModal();
            loadFiles();
            refreshDevices();
          });
        })
      ], false);
    });
    $("renameDeviceBtn").addEventListener("click", function () {
      var device = selectedDevice();
      if (!device || device.shared) return;
      askText("Rename device", "Device name", device.name, function (name) {
        api("POST", "/api/devices/rename", { deviceId: device.id, name: name }, function (err) {
          if (err) { toast(err.message, true); return; }
          closeModal();
          refreshDevices(function () { updateHeading(); });
        });
      });
    });
    $("removeDeviceBtn").addEventListener("click", function () {
      var device = selectedDevice();
      if (!device || device.role === "home") return;
      var wrap = el("div");
      wrap.appendChild(el("p", "", "Remove " + device.name + " from the list? Files already on that device are not deleted. If it connects again, it will show up."));
      openModal("Remove device", wrap, [
        button("Cancel", "btn secondary", closeModal),
        button("Remove", "btn danger", function () {
          api("POST", "/api/devices/remove", { deviceId: device.id }, function (err) {
            if (err) { toast(err.message, true); return; }
            closeModal();
            state.deviceId = "";
            state.path = "";
            refreshDevices(function () { loadFiles(); });
          });
        })
      ], false);
    });
    $("leaveBtn").addEventListener("click", function () {
      if (!window.confirm("Disconnect this device? Files already saved here stay on this device.")) return;
      api("POST", "/api/setup/leave", {}, function (err) {
        if (err) { toast(err.message, true); return; }
        api("GET", "/api/bootstrap", null, function (bootErr, data) {
          if (!bootErr && data) applyBootstrap(data);
        });
      });
    });
    function bindFileClicks(root) {
      if (!root) return;
      root.addEventListener("click", function (e) {
        var node = e.target;
        while (node && node !== root) {
          if (node.getAttribute && node.getAttribute("data-action")) {
            onFileAction(node.getAttribute("data-action"), node.getAttribute("data-path"));
            return;
          }
          node = node.parentNode;
        }
      });
    }
    bindFileClicks($("fileList"));
    bindFileClicks($("folderGrid"));
    $("deviceList").addEventListener("click", function (e) {
      var node = e.target;
      while (node && node !== $("deviceList")) {
        if (node.getAttribute && node.getAttribute("data-id")) {
          if (state.deviceId !== node.getAttribute("data-id")) {
            state.deviceId = node.getAttribute("data-id");
            state.path = "";
            $("search").value = "";
            renderDevices();
            loadFiles();
          }
          return;
        }
        node = node.parentNode;
      }
    });
    window.addEventListener("dragover", function (e) { e.preventDefault(); });
    window.addEventListener("drop", function (e) {
      e.preventDefault();
      $("dropZone").className = "drop";
      if ($("appScreen").className.indexOf("hidden") !== -1) return;
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) uploadFiles(e.dataTransfer.files);
    });
    $("dropZone").addEventListener("dragover", function () { $("dropZone").className = "drop drop-hot"; });

    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").catch(function () {});
    }

    api("GET", "/api/bootstrap", null, function (err, data) {
      if (err) {
        $("bootScreen").innerHTML = "<p>Cannot open ServerOS. If you just closed the window, start it again.</p>";
        return;
      }
      applyBootstrap(data);
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
