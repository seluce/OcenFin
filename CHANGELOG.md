# Changelog

Notable changes to OcenFin. Versions are release dates (`YYYY.MM.DD`) and match
`public/appinfo.json` as well as the version shown under Settings → Status.

## [Unreleased]

### Changed

- **One corner for a card's status.** Top right now shows the time or episodes left, or a green tick
  once you have seen it all, instead of a tick, a count and a full bar at once.
- **"Episode count" is now "Unwatched episodes".** Series in the library show how many episodes are
  still left instead of their total.

### Internal

- **Updated picture-subtitle library.** libbitsub 1.13.0 also stops a subtitle download that is no
  longer needed when you switch tracks.
- **Updated build tools.** Svelte 5.57.2 and Vite 8.3.4, both patch releases with bug fixes only.

## 2026.10.04

### Added

- **Skip Recap.** A "Skip Recap" button like "Skip Intro", optionally automatic; it needs a server
  that marks recaps, such as the Intro Skipper plugin.
- **Play straight from the home screen.** The banner's Play button starts the title right away, and
  a card's menu now begins with Play or Resume.
- **Series and season pages show what comes next.** Play names the episode it starts, and the
  episode you move onto shows its length and description below the row.
- **Find subtitles from the TV.** "Search subtitles…" on a title's page downloads a subtitle from
  the server's providers and selects it, for profiles allowed to manage subtitles.
- **Labelled player buttons.** Every button in the player shows its name when you move onto it.
- **The A–Z bar can be switched off.** You find it under Settings → Content → Library.

### Changed

- **Settings are grouped.** Each group sits in its own card with a heading, and the subtitle options
  explain themselves in plain words.
- **Less grey.** The selected card glows softly in your accent colour, a title's page takes on a
  hint of its poster's colour, and quieter pages carry a faint glow.
- **Banner and backdrop no longer overlap on the home screen.** One step into the rows moves the
  banner away completely, and the selected title's picture fades in.
- **The library sorts from one row of buttons.** Pressing the active sort again flips its direction;
  the separate Sort button is gone.
- **Track memory per profile.** Each profile now remembers its own audio and subtitle choice for
  every series.
- **Removing a server cleans up after it.** Its profiles' settings and search history are removed
  from the TV as well.
- **Watch together is hidden on age-restricted profiles.** Such profiles keep to their own titles.
- **A cleaner look.** "Watched" is green on every card, the random-title button is called "Surprise
  me", and the sign-in screens show the app's logo and a colour per profile.
- **Snappier buttons.** A button's highlight appears the moment you reach it; only the slight zoom
  is still animated.
- **DVB picture subtitles are no longer switched on automatically.** The server can only burn them
  into the picture, which costs direct playback, so you choose them yourself.

### Fixed

- **Signing in no longer wastes login attempts.** Enter after the user name or a held OK button no
  longer sends empty or repeated passwords, which could lock an account.
- **Standby no longer signs you out.** A server that is not reachable yet after waking the TV is
  simply waited for.
- **Back works on the server list.** Quick Connect also stops when you leave it or its code expires.
- **The right episode plays.** The "Unwatched" filter works, a season starts at its first unwatched
  episode, and a fully watched series at episode 1 instead of a special.
- **Playback keeps your place.** That now holds after Back while a title is still loading and after
  a playback error.
- **The track you pick on a title's page is the one that plays.**
- **Skipping and subtitles in the player.** Skip Intro works right after Skip Recap, the subtitle
  delay survives an audio switch, and end credits are recognised more reliably.
- **SyncPlay.** The next episode starts at its beginning, the TV stays with the group, and a group
  that cannot be created or joined says so.
- **Back returns to where you were.** That includes "Surprise me", a card's menu, the banner and
  collections, and dialogs no longer leave nothing selected.
- **The server saying no is handled.** Refused changes undo themselves, a removed title shows a
  message, and the watchlist recovers if its playlist was deleted elsewhere.
- **A steadier home screen.** It copes with two recommendations of the same name, fills in rows
  after you left it early, and carries nothing over to the next profile.
- **Smaller fixes.** Theme music stops with the screensaver, a double press on Play keeps the way
  back, the A–Z bar marks the right letter, and times follow your language.

### Internal

- **Updated build tools.** Vite 8.3.1 and its Svelte plugin 7.3.1, both patch releases.
- **Old code and comments cleaned up.** A start from the home screen now also asks the server once
  instead of twice.

## 2026.09.27

**This release needs Jellyfin Server 12.0 or newer.** On an older server, stay on 2026.09.22.

### Added

- **Rewind and fast-forward from another device.** When the TV is controlled from Jellyfin on a
  phone or in the browser, both buttons now work, using the player's own step.
- **"Included in" on the details page.** A title that belongs to a collection shows it in its own
  row, one click away.
- **Filter a library by audio and subtitle language.** The filter lists the languages your titles
  actually have, for example to show only films with German audio.

### Changed

- **Back from a suggestion returns to it.** With Jellyfin 12 the "More like this" row loads in time,
  so Back lands on the card you picked.
- **The setting "Auto-pick forced DVD subtitles" is gone.** Jellyfin 12 always delivers DVD
  subtitles, so they are picked like any other.
- **Your audio and subtitle language apply to every start.** A series' Play button, play all,
  shuffle, extras and starts from another device now choose tracks like the details page does.

### Fixed

- **Quick Connect works again.** Signing in with a code failed on Jellyfin 12, and approving another
  device from the settings failed on every server.
- **Titles in several versions behave.** Seek previews and audio and subtitle choices now follow the
  version you are actually watching.
- **Back retraces your steps.** It no longer bounces between a film and a cast member or collection,
  and after playback or a cast member's page it returns to the page you came from.
- **A profile without a password can be added to watch together.** On Jellyfin 12 its password
  prompt kept coming back.
- **People in your favourites are sorted alphabetically.** The server ignored the requested order,
  so they appeared at random.

### Internal

- **Current Jellyfin addresses.** Requests no longer use the older per-profile routes, which
  Jellyfin 12 no longer documents.
- **Playlists are created the documented way.** They stay private, and parameters the server ignores
  are no longer sent.
- **Code for servers before 12 is gone.** That includes the DVD subtitle version check and an old
  intro plugin interface.

## 2026.09.22

### Changed

- **The countdown to the next episode runs smoothly.** Its bar is now drawn by the graphics side, so
  it no longer stutters while the picture decodes, with "Reduce animations" on as well.
- **Age-restricted profiles can save their password again.** They can be picked without typing it on
  the remote; the other sign-in options stay hidden.

### Fixed

- **Episodes count as watched again and keep their place.** Converted titles were saved at the wrong
  position, and short episodes with long credits fell just short of "watched".
- **The player controls hide again after you return from the home screen.** Coming back mid-film
  could leave the control bar on screen until you pressed a key.

### Internal

- **hls.js 1.7.3.** It fixes a rare wrong duration after seeking to the very end of a stream.
- **Svelte 5.57.1 and Vite 8.3.0.** Both are patch releases of the build tools.
- **A diagnostic line when waking from the screensaver.** It sits behind the debug switch and helps
  chase a rare resume problem.

## 2026.08.31

### Fixed

- **The very first start puts you on "add server".** It used to open with nothing selected.
- **The watchlist stays quiet when the server answers oddly.** A proxy's error page no longer shows
  up as an error, and the list syncs again on the next load.

### Internal

- **The page declares its actual language.** It used to claim English whatever was shown.
- **One poster card for collections, favourites and cast pages.** It replaces three identical
  copies; nothing changes on screen.
- **Svelte 5.57.0.** It brings fixes to transitions that the app's dialogs rely on.

## 2026.08.27

### Fixed

- **Cast member pages keep your place.** Opening one of their titles and coming back returns to the
  same spot, Back no longer bounces between the two, and the remote's Back key works like the
  button.
- **Collections and watchlists open on their first title.** A collection inside a collection also
  steps back one level at a time.
- **Libraries and the home screen keep you on the page.** A library opened from the home screen
  starts on its first title, and going back returns you to its tile or to the first row.
- **Opening the settings or a search result moves you into it.** Focus no longer stays on the menu
  or on a button that just disappeared.
- **Editing a playlist keeps the remote working.** Deleting or moving entries leaves focus on a
  sensible neighbour.
- **Filtered libraries and playback errors no longer strand you.** Leaving a title lands on the one
  that moved up, and "try again" after an error keeps the remote working.
- **After watching, a title page puts you back on its Play button.** You no longer land on the cast
  member you came through.
- **Theme music follows the title you are looking at.** It changes or falls silent as you move
  through "More like this".
- **Watched and favourite marks apply to the title you are on.** They were also written onto the
  title you had originally opened.
- **Settings lists open on your current choice.** Choosing a menu symbol also keeps focus on its
  entry.
- **Small sign-in fixes.** Removing a server keeps the remote working, leaving the password entry
  returns to your profile, and the on-screen keyboard no longer opens unasked.

## 2026.08.25

### Added

- **Connecting prefers HTTPS and fills in the rest.** Type just an address such as `192.168.1.100`;
  the app finds scheme and port, trying the encrypted connection first.
- **Servers found by the automatic search use HTTPS when they offer it.** The search stays quick and
  only checks the server you pick.
- **Fewer settings on age-restricted profiles.** Screensaver, account, diagnostics and sign-in
  options are hidden; this tidies the interface rather than locking anything.
- **Unencrypted servers are marked.** An amber HTTP badge reminds you that passwords travel the
  network in the clear.

### Changed

- **Back returns you to where you were.** On the home screen you land on the card you opened, and
  inside a title's page Back steps back one level at a time.
- **Search, favourites, collections and watchlists keep their place.** Coming back from a title
  finds them as you left them, and search got a ✕ to clear the field.
- **The app opens on your first library.** The sidebar stays closed until you need it.
- **The home screen loads faster.** "Recently added series" no longer arrives seconds late, and the
  featured banner appears sooner.
- **Opening the sidebar is smoother.** The current entry no longer carries a glow that had to be
  redrawn on every frame.
- **Watch together asks the server far less.** It reuses data it already has and fetches both
  partners at once.

### Fixed

- **The shareable diagnostic log no longer contains your access token.** Lines are masked before
  they are stored.
- **A crafted trailer link can no longer run code.** Trailers are limited to YouTube embeds and
  ordinary video links.
- **Fewer accidental sign-outs.** A network hiccup or a feature your account may not use no longer
  signs you out.
- **Signing out really ends the access.** Removing a server or signing out now also ends the login
  on the server and clears all of that server's saved tokens.
- **Watch together without typing someone else's password.** It can now be set up with Quick Connect
  and can include hidden profiles.
- **The password prompt appears whenever the server asks for one.** You no longer get a generic
  sign-in error instead.
- **Watch together tells you when a profile needs signing in again.** It no longer quietly filters
  with only one of the two.
- **Group playback keeps in step when the TV's clock is off.** The difference to the server's clock
  is now measured and accounted for.
- **Title logos no longer make the details page jump.** The title area keeps a steady height.
- **A damaged settings file can no longer stop the app from starting.** Broken values fall back to
  their defaults.
- **Easier to read.** Destructive buttons stay calmly red instead of flaring up, and small grey text
  under posters is brighter.
- **Scrolling a large library asks the server for less.** The server no longer counts the whole
  library for every page.

### Internal

- **Shared code instead of copies.** Seven pieces that existed several times now live in one place;
  nothing changes on screen.

## 2026.08.22

### Added

- **Settings → Remote.** Number-key jump and channel zapping can be switched off there, and each of
  the four colour buttons can get an action.
- **Subtitles on/off restores the track you had.** It no longer opens a menu when there is something
  to restore.
- **Theme music on the details page.** A title's theme song fades in, for movies, shows or both, at
  its own volume.

### Changed

- **Much smoother scrolling in large libraries.** Poster placeholders are now prepared many times
  faster, without any visible difference.
- **Faster D-pad navigation.** The difference is most noticeable deep inside a large library.
- **Less background work during playback and scrolling.** Subtitles, the "ends at" time and the A–Z
  indicator do a fraction of their former work.

### Fixed

- **Libraries no longer stop after 50 titles.** The next pages always arrive now.
- **An expired session returns you to the profile picker.** The app no longer keeps running against
  nothing.
- **Watchlist, collections and settings.** A stuck "saved" button, a dead Back button in nested
  collections and an endless request loop are fixed.
- **The screensaver also runs on the server and profile screens.** OLED panels are protected there
  too.
- **Burned-in subtitles switch off and on properly.** The picture no longer keeps them after "Off".
- **Auto-play keeps your audio track.** It also respects a chapter jump during the countdown, and
  Previous no longer lands on the next episode.
- **Playback no longer attaches an outdated stream.** That could happen when its setup restarted
  mid-load.
- **The player panels leave focus where you can see it.** OK works again right after closing them.
- **Watch together no longer mixes up libraries.** Switching while partner data loaded could filter
  against the wrong library.
- **Server errors no longer pass unnoticed.** List queries also stopped making the server count the
  whole library.

### Internal

- **All new settings are translated into all eight languages.**
- **Review, performance and edge-case passes.** Diagnostics behind the debug switch helped find most
  of the fixes above.

---

*Releases before this entry are not reconstructed here — see the
[GitHub releases](https://github.com/seluce/OcenFin/releases) for their notes.*
