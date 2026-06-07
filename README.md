# OcenFin - another Jellyfin WebOS Client

OcenFin is a native WebOS app for LG TVs. Just to be clear: I don't want to build the ultimate WebOS Jellyfin app. I just built it for my own needs. If you want an app with many features, check out MoonFin, Litefin, or Breezyfin. They also offer native apps for WebOS.[span_0](start_span)[span_0](end_span)

The official Jellyfin app from the LG App Store is basically just a web browser wrapper. It's just the normal website, which is not optimized for WebOS. Our main problem: We switch users on the TV very often. In the official app, this is annoying. You have to log out, select the server again, and then choose the user. Also, the performance on our LG B4 TV was very slow. The picture quality of the TV is great, but the hardware struggles with heavy apps.[span_1](start_span)[span_1](end_span)

So I thought about how to make a better app for us: First, it should be a native WebOS app based on Svelte and Tailwind. Svelte helps us avoid heavy frameworks so the app stays very lightweight. This makes it much nicer to use. I also decided to hide some details that are not very important.[span_2](start_span)[span_2](end_span)

Now, there is a quick user switch to easily change profiles. If you want, you can save your password (using a token). Then you can jump right into your profile without typing the password again.[span_3](start_span)[span_3](end_span)

### Features & Summary
- **Svelte-based:** Very lightweight, supports English and German.[span_4](start_span)[span_4](end_span)
- **Minimalist Design:** Made for WebOS. Focuses on speed for older devices by removing things you don't really need.[span_5](start_span)[span_5](end_span)
- **Fast User Switching:** Switch between profiles quickly and easily.
- **Save Passwords:** Save your password as a token for instant login.[span_6](start_span)[span_6](end_span)
- **Custom Avatars:** Create your own profile picture directly on the TV using built-in SVG templates. No need to upload images.
- **Shared Profile:** Compare different profiles in one view. Easily find a movie that nobody has watched yet.
- **SyncPlay Support:** Watch movies together with the built-in SyncPlay feature.

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
