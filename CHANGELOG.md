# Changelog

Notable changes to OcenFin. Versions are release dates (`YYYY.MM.DD`) and match
`public/appinfo.json` as well as the version shown under Settings → Status.

## [Unreleased]

### Added

- **Connecting prefers HTTPS.** Type just an address like `192.168.1.100:8096` and the app tries
  the encrypted connection first, falling back to plain HTTP only if the server offers nothing else
  — you no longer have to know to type `https://`. Servers reached over unencrypted HTTP are marked
  with a small **HTTP** badge in the server list and settings, as a reminder that the password and
  token travel the network in the clear. Typing an explicit `http://` is still respected.

### Fixed

- **The shareable diagnostic log no longer contains the access token.** Stream and subtitle URLs
  embed it as a query parameter, and the player logged such URLs — so sharing the log through the
  QR code on the status page handed out the server address plus a valid token. Log lines are now
  masked before they enter the buffer; the browser console keeps full URLs for development.
- **A trailer from booby-trapped metadata can no longer run code.** A title's trailer link comes
  from external sources (TMDb, NFO files); a crafted one could previously reach the video frame and,
  in the worst case, run in the app's context with access to your stored login. Trailers are now
  restricted to genuine YouTube embeds and ordinary video links.
- **Fewer accidental sign-outs.** A single network hiccup or a feature your account isn't permitted
  to use (such as SyncPlay) could log you out and make you re-enter your password on the remote. The
  app now confirms the session is really gone before signing out, and no longer treats "not allowed"
  as "signed out".
- **Removing a server now clears all of its saved tokens**, including the ones kept for watch
  together; leftovers from very old versions are cleaned up too. **Quick Connect** no longer leaves
  a login code active in the background after a successful sign-in.

### Internal

- The seven structural refactors deferred in `CODE-HEALTH.md` §10 are done: one source for the
  profile-pref defaults, one previous-episode path, one option-picker modal, shared series
  expansion, shared card-image helper, shared auth header, shared remembered-track matcher.
  No behavior change intended.

## 2026.08.22

### Added

- **Settings → Remote** — a new category collecting every remote-control shortcut in one place, so
  they are discoverable instead of hidden.
  - **Number-key jump** and **channel-rocker zapping** can be switched off there. Both stay on by
    default; switched off, the key passes through untouched instead of being swallowed. The channel
    rocker is the easiest key to hit by accident, so the switch doubles as protection against that.
  - **The four colour buttons** can now be assigned. They start out unassigned, and each one can be
    pointed at a single action: previous/next chapter, subtitles on/off, the subtitle menu, the
    audio menu, previous/next episode, or play/pause. They only do anything during playback. A key
    bound to one of the two menus closes it again on a second press, and switches straight over if
    the other menu is showing.
- **Subtitles on/off** remembers the track that was running, so switching them back on restores the
  same one instead of opening a menu. With nothing to restore it opens the subtitle tab.
- **Theme music on the details page** — opening a title softly fades in its theme song, limitable to
  movies or shows, with its own volume. This was announced with 2026.08.20, but that build shipped
  an outdated main component and the feature never actually ran. It works from this release on.

### Changed

- **Much smoother scrolling in large libraries.** Preparing a poster's blurred placeholder was by
  far the most expensive thing the app did: measured on an LG B4 at 15–21 ms per poster and
  occasionally over half a second, all of it blocking, and all of it while a page of cards was
  appearing. It now takes under 2 ms. Nothing looks different — the placeholders are identical,
  pixel for pixel.
- **Faster D-pad navigation**, most noticeably deep inside a large library. Every arrow press used
  to measure the same on-screen elements up to four times over, and to run a style check across
  every candidate on screen although the geometry only ever picks one. Each element is now measured
  once, and the check applies to the chosen element. Measured on an LG B4 deep in a large library,
  the average time spent before focus moves dropped from roughly 19 ms to 4 ms. Nothing about how
  focus moves has changed — only the work done before it moves.
- **Less background work during playback and scrolling.** With external subtitles the whole cue list
  was searched from the start several times per second, the "ends at" clock rebuilt a date formatter
  just as often for a value that changes once a minute, and the A-Z indicator re-measured every card
  above the screen after each scroll. All three now do a fraction of that work.

### Fixed

- **Libraries could stop loading after their first 50 titles**, with no spinner and no way to
  continue except jumping ahead with the A-Z bar. A page request could overlap the initial load,
  come back holding only titles already on screen, and be read as "the library ends here" — which
  capped the view for the rest of the session. Which library it hit came down to timing, so it
  looked like it affected only movies, or only shows, and swapped after a restart.
- **A session that stopped being valid left the app running against nothing** — empty rows, posters
  falling back to placeholders, playback failing — with no way back to signing in short of a
  restart. That happens when the device is revoked in the Jellyfin dashboard, the password changes,
  the account is deleted or the server is restored from a backup. It now returns to the profile
  picker and forgets the stale token.
- **Watchlist:** if creating the playlist failed on the very first bookmark, the button stayed stuck
  showing "saved" and could not be used again until a restart.
- **Collections:** opening a collection from inside another collection made the Back button do
  nothing — the only way out was the sidebar.
- **Settings:** on a server that hides its public user list, opening Settings started an endless
  stream of requests.
- **Screensaver:** on the server and profile selection screens neither OcenFin's nor the TV's
  screensaver ran, so a bright static screen could stay on an OLED panel indefinitely.
- **Subtitles:** switching them off while a burned-in subtitle was playing left it in the picture
  while the interface already showed "Off". Switching back on did not work either.
- **Auto-play:** an explicitly chosen audio track could be lost when the next episode started by
  itself — the episode then played the file's default language.
- **Auto-play:** jumping to another chapter during the outro countdown no longer lets the next
  episode start anyway. The jump cancels the countdown, same as a number-key jump.
- **Previous episode:** pressing it in the last moment of the outro countdown could land on the
  *next* episode instead.
- **Playback** could attach an outdated stream when its setup was restarted mid-load — by the
  transcode fallback, a track switch, or a command from the Jellyfin dashboard.
- **Player:** closing the audio or subtitle panel could leave no visible focus and an unresponsive
  OK button for a few seconds.
- **Watch together:** switching library while partner data was still loading could filter the new
  library against the previous library's watched titles.
- **Server errors no longer pass unnoticed.** Twelve requests parsed their response without checking
  whether it succeeded, so a failure made the feature do nothing at all — a dashboard row that never
  appeared, a button that did nothing, search results missing their people.
- **Server load:** eight list queries asked the server for a total count that was never used.

### Internal

- The new settings and all their options are translated into all eight languages.
- `CODE-HEALTH.md` §10–§12 record the work behind this release: an eight-angle review pass with each
  finding verified individually, a performance pass driven by measurements from the TV, and an
  edge-case audit of failure paths and boundary values. They also record what was deliberately left
  alone, and which plausible explanations were measured and disproved.
- Diagnostics behind the existing debug switch: boot milestones, D-pad timing, placeholder decode
  timing, heap and DOM size for long sessions, and library paging. All inert while debug is off, and
  reported through the log buffer the settings page already shares by QR code. Most of the fixes
  above were found with them rather than guessed at.

---

*Releases before this entry are not reconstructed here — see the
[GitHub releases](https://github.com/seluce/OcenFin/releases) for their notes.*
