[繁體中文](README.md) | **English**

<p align="center">
  <img src="docs/images/icon.png" width="96" height="96" alt="NH Shelfie icon">
</p>

<h1 align="center">NH Shelfie</h1>

<p align="center">Your own nhentai bookshelf on your phone: save galleries by ID, sort them into folders — no account, nothing uploaded.</p>

<p align="center">
  <a href="https://github.com/anson669989/NH-Shelfie/releases/latest"><img src="https://img.shields.io/github/v/release/anson669989/NH-Shelfie?label=version" alt="Version"></a>
  <a href="https://github.com/anson669989/NH-Shelfie/releases"><img src="https://img.shields.io/github/downloads/anson669989/NH-Shelfie/total?label=downloads" alt="Downloads"></a>
  <img src="https://img.shields.io/badge/Android-6.0%2B-3ddc84?logo=android&logoColor=white" alt="Android 6.0+">
</p>

<h3 align="center">
  <a href="https://github.com/anson669989/NH-Shelfie/releases/latest">⬇️ Download the latest APK</a>
</h3>


## ✨ Features

- 🔒 **Local collection, no account**: everything stays on your phone.
- ⚡ **Add without waiting**: type an ID and tap Add — title and cover are filled in automatically in the background.
- 🔢 **Paste the ID any way**: plain numbers, `#228922` or a URL all work.
- 🔗 **Add from the browser's Share menu**: tap Share on a page → NH Shelfie, and the ID is filled in.
- 📁 **Folders**: put an item in several folders; each folder remembers its own sort order.
- ☑️ **Multi-select**: long-press a cover to select many, then add to folders, remove or delete at once.
- ⋮ **Item menu**: the button at the top-right of each cover shows full titles, copies the ID and re-fetches the cover.
- 🌏 **Four languages**: 繁體中文, 简体中文, English, 日本語.
- 💾 **Export for backup**: export a CSV and import it on a new phone.


## 📱 Screenshots

<p align="center">
  <img src="docs/screenshots/library.jpg" width="30%" alt="Library">
  <img src="docs/screenshots/add.jpg" width="30%" alt="Add">
  <img src="docs/screenshots/settings.jpg" width="30%" alt="Settings">
</p>
<p align="center">Library · Add · Settings</p>


## 🚀 Quick start

1. **Download and install**: open "Download the latest APK" above on your phone, download `nh-shelfie.apk` and tap it to install.
2. **Add your first item**: in the Add tab, enter an ID (e.g. `228922` or `#228922`) and tap Add. Or tap Share on a browser page and choose NH Shelfie.
3. **Sort it**: pick folders before adding (your last choice is remembered). Later, tap "⋮" on a cover → Folders, or long-press covers to select several and sort them at once.

## ❓ FAQ

<details>
<summary><b>Android says "unknown sources" or blocks the install. What do I do?</b></summary>

The app isn't on Google Play, so Android asks for permission. Tap "Settings" in the prompt, allow "Install unknown apps" for the browser (or file manager) you downloaded with, then go back and tap Install. If Play Protect shows a warning, choose "Install anyway".
</details>

<details>
<summary><b>How do I update?</b></summary>

Download the new APK from the [Releases page](https://github.com/anson669989/NH-Shelfie/releases/latest) and install it over the old one — your collection is kept. **Don't uninstall first**: uninstalling deletes your data.
</details>

<details>
<summary><b>Where is my data stored?</b></summary>

Your list, folders and covers are stored in the app's private storage on this phone. Other apps can't see them and covers don't show up in your gallery.
</details>

<details>
<summary><b>How do I move to a new phone?</b></summary>

Old phone: Settings → Data → Export CSV, then save it to cloud storage or send it to yourself. New phone: install the app, then Settings → Data → Import CSV. Folders are recreated, and titles and covers are downloaded again automatically.
</details>

## 🔐 Privacy

All data lives only on your phone. The app collects and uploads nothing, has no ads or analytics, and needs no login. It only connects directly to the website to fetch public titles and covers.

## ⚖️ Disclaimer

This is an unofficial personal project and is not affiliated with nhentai in any way. Please follow the laws where you live.

---

<sub>Developer docs (architecture, build, release): [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)</sub>
