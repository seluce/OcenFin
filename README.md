# OcenFin - another Jellyfin WebOS Client

OcenFin will be a native WebOS app for LG TVs. Let me be clear: I am not trying to create the ultimate WebOS Jellyfin app (based on AI); it is simply meant to serve my own needs. If you are looking for a feature-rich native app, check out MoonFin, Litefin, Breezyfin which also offers an native app for WebOS.

While the official Jellyfin app is available in the LG App Store, it is essentially just a browser wrapper. It's nothing more than the Jellyfin website, which is not optimized for WebOS (LG TVs). Our problem: We switch users on the TV very often. Doing this with the official app is quite annoying because you first have to log out the user, then select the server again, just to be able to select the correct user. Furthermore, the performance on our LG B4 was very sluggish. The picture quality is great, but the hardware isn't really designed for such crappy apps.

Therefore, I thought about how the app could make more sense for us: First, a native app for WebOS, based on Svelte. The language allows us to ditch heavy frameworks and keep the app very lightweight. This should make the user experience much more pleasant. Certain elements are deliberately omitted, such as less relevant details.

Additionally, there is now a quick user switch feature to easily alternate between user profiles. If desired, you can have the password for your profile saved (via a token). This allows you to switch directly into that user profile without having to re-enter the password.

### Summary
- OcenFin is based on Svelte (supports EN + DE)
- Focuses on maximum speed for older devices
- Deliberately omits certain elements
- Emphasizes fast user switching

### Screenshots

<p align="center">
  <a href="https://github.com/user-attachments/assets/0ea903ba-1145-4705-b18e-4316f310b48e" target="_blank">
    <img src="https://github.com/user-attachments/assets/0ea903ba-1145-4705-b18e-4316f310b48e" width="48%" alt="OcenFin Screenshot 1" />
  </a>
  <a href="https://github.com/user-attachments/assets/c9983d9d-cca2-40df-80ee-443466aca4b7" target="_blank">
    <img src="https://github.com/user-attachments/assets/c9983d9d-cca2-40df-80ee-443466aca4b7" width="48%" alt="OcenFin Screenshot 2" />
  </a>
</p>

<p align="center">
  <a href="https://github.com/user-attachments/assets/39d89a07-fc4b-42b5-abdb-3c2f23d03a61" target="_blank">
    <img src="https://github.com/user-attachments/assets/39d89a07-fc4b-42b5-abdb-3c2f23d03a61" width="31%" alt="OcenFin Screenshot 3" />
  </a>
  <a href="https://github.com/user-attachments/assets/e5e0a18a-b321-49b5-8492-0f0fdc07baf1" target="_blank">
    <img src="https://github.com/user-attachments/assets/e5e0a18a-b321-49b5-8492-0f0fdc07baf1" width="31%" alt="OcenFin Screenshot 4" />
  </a>
  <a href="https://github.com/user-attachments/assets/454029be-c3b6-4522-9958-5031b29e2587" target="_blank">
    <img src="https://github.com/user-attachments/assets/454029be-c3b6-4522-9958-5031b29e2587" width="31%" alt="OcenFin Screenshot 5" />
  </a>
</p>
