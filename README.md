<h1 align="center">OcenFin – another Jellyfin WebOS Client</h1>

<p align="center">
  <a href="https://github.com/seluce/OcenFin/issues"><img src="https://img.shields.io/github/issues/seluce/OcenFin?style=flat-square&color=blue" alt="Open Issues"></a>
  <a href="https://github.com/seluce/OcenFin/stargazers"><img src="https://img.shields.io/github/stars/seluce/OcenFin?style=flat-square&color=yellow" alt="GitHub Stars"></a>
  <a href="https://github.com/seluce/OcenFin/network/members"><img src="https://img.shields.io/github/forks/seluce/OcenFin?style=flat-square&color=lightgrey" alt="GitHub Forks"></a>
</p>

> OcenFin is a native WebOS app for LG TVs. Just to be clear: I don't want to build the ultimate Jellyfin app. I just built it for my own needs. If you want an app with many features, check out MoonFin, Litefin, or Breezyfin. They also offer native apps for WebOS. 

The official Jellyfin app from the LG App Store is basically just a web browser wrapper. It's just the normal website, which is not optimized for WebOS. My main problem was that I switch users on the TV very often. In the official app, this is annoying. Also, the performance on my LG B4 TV was very slow. 

So I decided to build a better app: A native WebOS app based on Svelte and Tailwind. I hid some details that are not very important to keep it clean and simple.

---

## Features

* **Fast User Switching:** Switch between profiles quickly and easily. 
* **Save Passwords:** You can save your password as a token. Then you can jump right into your profile without typing the password again.
* **Shared Profile:** If you use a shared profile, you can link two personal profiles to it. It hides movies or series that one of you has already seen. This makes it easy to find something new to watch together.
* **Custom Avatars:** Create your own profile picture directly on the TV. You can use your recently watched shows or movies as a background. Or you can choose an SVG icon with a custom background. No need to upload images.
* **WebSockets & SyncPlay:** Full WebSocket support for remote commands from the Jellyfin server and SyncPlay features to watch together.
* **Direct Play Focus:** I use `libbitsub`, `assjs`, and `hls` to support many formats. This helps to run Direct Play on the TV and avoid transcoding on the server, even for complex subtitles like VobSub and DVDSub.
* **Multi-Language:** The app supports English, German, Spanish, French, Italian, Dutch, Portuguese, and Polish.

---

## Under the Hood

OcenFin is made for WebOS and focuses on speed for older devices.

* **Tech Stack:** Built with Svelte and Tailwind CSS.
* **No Frameworks:** Svelte helps me avoid heavy frameworks. This keeps the app very lightweight and fast.
* **Minimalist Design:** I removed things you don't really need to keep the interface clean and fast.

---

## Installation

You can install OcenFin via an `.ipk` file. **No root is required.**

First, choose the right `.ipk` version for your TV from the Releases page:
* **Modern:** For newer LG TVs running **WebOS 22+** (2022 models and above). This version delivers highly optimized, modern code for maximum performance on all recent chipsets.
* **Legacy:** For older LG TVs running **WebOS 5 or WebOS 6**. Choose this if the modern version gives you a black screen.

1. **Prepare the TV:** Install the official "Developer Mode" app from the LG Content Store on your TV and enable it.
2. **Sideload from PC:** To install the app from your computer to the TV, I highly recommend using **[dev-manager-desktop](https://github.com/webosbrew/dev-manager-desktop)**. It provides a very easy-to-use graphical interface.
3. **Bypass the 50-Hour Limit:** LG restricts developer apps to a 50-hour lifespan. To keep OcenFin working permanently, use `dev-manager-desktop` to also install the **"Auto Dev Token Refresh"** app on your TV. It automatically resets the timer in the background so your apps never expire.

---

## Work in Progress

* **Keep it Simple:** Instead of blindly adding new features, my main focus is on making the existing app better, faster, and more stable.
* **Smarter Settings:** Expanding the settings menu with useful options that perfectly fit the app's philosophy.

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
