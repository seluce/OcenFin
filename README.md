<h1 align="center">OcenFin – another Jellyfin webOS Client</h1>

<p align="center">
  <a href="https://github.com/seluce/OcenFin/issues"><img src="https://img.shields.io/github/issues/seluce/OcenFin?style=flat-square&color=blue" alt="Open Issues"></a>
  <a href="https://github.com/seluce/OcenFin/stargazers"><img src="https://img.shields.io/github/stars/seluce/OcenFin?style=flat-square&color=yellow" alt="GitHub Stars"></a>
  <a href="https://github.com/seluce/OcenFin/network/members"><img src="https://img.shields.io/github/forks/seluce/OcenFin?style=flat-square&color=lightgrey" alt="GitHub Forks"></a>
</p>

> OcenFin is a fast and lightweight Jellyfin client for LG webOS TVs. Built with Svelte 5, it takes up almost no space and runs smoothly. It is actively tested on an LG B4 and fully supports **Dolby Vision** and **Dolby Atmos** via **Direct Play**.
> 
> **Please note:** OcenFin is made only for movies and TV shows. It does **not** include **IPTV (Live TV)** or **Music**. Why? IPTV doesn't always run smoothly. And for music, there are already great tools like Navidrome that do a much better job.

---

## Features

* **Fast User Switching:** Switch between profiles quickly and easily. 
* **Save Passwords:** You can save your password as a token. Then you can jump right into your profile without typing the password again.
* **Shared Profile:** If you use a shared profile, you can link two personal profiles to it. It hides movies or series that one of you has already seen. This makes it easy to find something new to watch together.
* **Custom Avatars:** Create your own profile picture directly on the TV. You can use your recently watched shows or movies as a background. Or you can choose an SVG icon with a custom background. No need to upload images.
* **WebSockets & SyncPlay:** Full WebSocket support for remote commands from the Jellyfin server and SyncPlay features to watch together.
* **Direct Play Focus:** I use `libbitsub`, `assjs`, and `hls.js` to support many formats. This helps to run Direct Play on the TV and avoid transcoding on the server, even for complex subtitles like VobSub and DVDSub.
* **Multi-Language:** The app supports English, German, Spanish, French, Italian, Dutch, Portuguese, and Polish.

---

## Installation

You can install OcenFin via an `.ipk` file. **No root is required.**

First, download the `.ipk` file for your TV from the Releases page:
* **Modern:** This version is exclusively tested and fully functional on **webOS 25 or newer**. Older webOS versions are not supported.

1. **Prepare the TV:** Install the official "Developer Mode" app from the LG Content Store on your TV and enable it.
2. **Sideload from PC:** To install the app from your computer to the TV, I highly recommend using **[dev-manager-desktop](https://github.com/webosbrew/dev-manager-desktop)**. It provides a very easy-to-use graphical interface.
3. **Bypass the 50-Hour Limit:** LG restricts developer apps to a 50-hour lifespan. To keep OcenFin working permanently, use `dev-manager-desktop` to also install the **"Auto Dev Token Refresh"** app on your TV. It automatically resets the timer in the background so your apps never expire.

---

## Documentation & FAQ

I have gathered a few more common questions into an FAQ and addressed them in the Wiki. I will continue to expand the Wiki and the FAQ over time: [Check out the OcenFin FAQ](https://github.com/seluce/OcenFin/wiki)

---

## Screenshots

<p align="center">
  <a href="https://github.com/user-attachments/assets/1c8d59cf-ef20-428a-ba4b-f331f40e242d" target="_blank">
    <img src="https://github.com/user-attachments/assets/1c8d59cf-ef20-428a-ba4b-f331f40e242d" width="49%" alt="Screenshot 1" />
  </a>
  <a href="https://github.com/user-attachments/assets/441a8c18-ffe7-4ff7-982c-0bbcf134d59f" target="_blank">
    <img src="https://github.com/user-attachments/assets/441a8c18-ffe7-4ff7-982c-0bbcf134d59f" width="49%" alt="Screenshot 2" />
  </a>
</p>

<p align="center">
  <a href="https://github.com/user-attachments/assets/40144986-febc-4756-a5ba-524d99fd6469" target="_blank">
    <img src="https://github.com/user-attachments/assets/40144986-febc-4756-a5ba-524d99fd6469" width="49%" alt="Screenshot 3" />
  </a>
  <a href="https://github.com/user-attachments/assets/88aa63ca-3a52-4b2a-b772-a110ff964d9e" target="_blank">
    <img src="https://github.com/user-attachments/assets/88aa63ca-3a52-4b2a-b772-a110ff964d9e" width="49%" alt="Screenshot 4" />
  </a>
</p>

<p align="center">
  <a href="https://github.com/user-attachments/assets/f8f42db7-528e-4f3b-b8e6-36f98182ef4d" target="_blank">
    <img src="https://github.com/user-attachments/assets/f8f42db7-528e-4f3b-b8e6-36f98182ef4d" width="49%" alt="Screenshot 6" />
  </a>
  <a href="https://github.com/user-attachments/assets/f80ad213-5295-4ceb-a878-bf86f88254cf" target="_blank">
    <img src="https://github.com/user-attachments/assets/f80ad213-5295-4ceb-a878-bf86f88254cf" width="49%" alt="Screenshot 7" />
  </a>
</p>

> **Note:** The images in the screenshots are just examples and demos. They do not show any real content.
