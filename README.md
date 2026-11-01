# ServerOS

ServerOS is a personal server that lives on your own devices. Files stay on the device you choose. Other phones and computers can open them only while that device is turned on and connected.

The first time you open it, create the owner account with a username, email, and password. Your own phone and computer log in with that account. Other people create their own login (they need the owner code shown on the main computer if they are not sitting at it). They can open your files, and their files stay separate.

## Windows

1. Install Node.js 16 or newer from https://nodejs.org if you do not already have it. Windows 7 needs Node.js 16. Newer Windows can use the current Node.js.
2. Double-click `Start ServerOS.bat`.
3. Leave the black window open. Your browser opens the setup page.
4. Choose **Keep files on this device** and create your account. Save the recovery key.

## Mac

1. Install Node.js 16 or newer from https://nodejs.org.
2. Double-click `Start ServerOS.command`. If Mac blocks it, open Terminal, type `chmod +x "Start ServerOS.command" start.sh`, then double-click it again.
3. Create the account in the browser window.

## Linux

In the ServerOS folder, run `sh start.sh`.

## Android phone app

The phone app is `phone\ServerOS-phone.apk`. Copy that file to the phone and open it to install. Android may ask you to allow installs from your files app.

1. On the computer, double-click `Start ServerOS.bat` and leave that window open. Create your account there.
2. On the phone, open ServerOS. The address is the one printed on the computer, such as `http://192.168.1.35:8787`.
3. Tap **Open my computer** to see the computer’s files.
4. Enter the same email or username and password, then tap **Connect this phone**. The phone shows up on the computer, and files saved on the phone can be opened there.

Older phones can still open the same address in the browser and use **Add to Home Screen**.

To make an Android tablet **the device that stores the files**:

1. Install Termux from F-Droid, or another Node.js 16+ install for that tablet.
2. Copy this ServerOS folder onto the tablet.
3. In Termux run `pkg update` and `pkg install nodejs`.
4. Open the folder and run `sh start.sh`.
5. Leave Termux open. Create the account in the tablet browser at the address ServerOS prints.

If that is too difficult on a very old tablet, keep ServerOS running on a computer that stays on, and use the tablet only to view and upload.

## iPhone and iPad

Open the address in Safari and use Share, then **Add to Home Screen**. An iPhone can upload and download. It cannot stay running as the server itself.

## Use it from another device

On the main device, ServerOS shows an address like `http://192.168.1.20:8787` and a QR code. Open that address on the other device and log in.

Same Wi-Fi works without extra setup. If a phone cannot connect, allow Node.js through the firewall when Windows asks.

From outside your home, the main device must stay on, and your router must forward port 8787 to that device. If the connection still fails, the internet provider may block incoming connections. Same Wi-Fi will still work.

## Store files on a second computer too

1. Install and start ServerOS on the second computer.
2. Choose **Join a ServerOS I already started**.
3. Enter the main address, your email or username, and your password.
4. Leave that window open. In the main ServerOS page, pick that device and upload. Those files stay on the second computer and disappear from the list when it is off.

## Backups

The first time you use ServerOS on a computer or Android phone, it asks permission to read that device's files.

- On Windows, Mac, and Linux it backs up your user folder, except temporary caches and ServerOS itself.
- On Android, install ServerOS in Termux and tap Allow when Android asks for storage. That backs up photos, downloads, documents, and the rest of shared storage.
- Files are compressed without losing data or picture quality. Documents get smaller. Photos and videos stay at the same quality, so their size stays about the same.
- The backup is copied to your other ServerOS devices that are turned on. You can open that copy when the original computer or phone is off.
- If you only have one device, the backup sits on that device and cannot be opened while it is off. Add a second device and leave it on.

iPhone and iPad can open backups, but they cannot run the backup server themselves.

## If you forget the password

Use the recovery key on the login screen. If you are at the main device, you can also choose **Reset password on this device**.

Files already uploaded remain in the `storage` folder next to this app.
