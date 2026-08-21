# Changelog

Notable changes to OcenFin. Versions are release dates (`YYYY.MM.DD`) and match
`public/appinfo.json` as well as the version shown under Settings → Status.

## [Unreleased]

### Added

- **Theme music on the details page** — opening a title softly fades in its theme song, limitable
  to movies or shows, with its own volume. Announced with 2026.08.20, but that build shipped an
  outdated main component, so the feature never actually ran; it works from this release on.
- **Settings → Remote** — a new category that collects every remote-control shortcut in one
  place, so they are discoverable instead of hidden.
- **Number-key jump** and **channel-rocker zapping** can be switched off there. Both stay on by
  default; switched off, the key is passed through untouched instead of being swallowed. The
  channel rocker is the easiest key to hit by accident, so the switch doubles as protection.
- **The four colour buttons** can now be assigned. They start out unassigned, and each one can be
  pointed at a single action: previous/next chapter, subtitles on/off, the subtitle menu, the
  audio menu, previous/next episode, or play/pause. They only do anything during playback.
- **Subtitles on/off** remembers the track that was running, so switching them back on restores
  the same one instead of opening a menu. With nothing to restore it opens the subtitle tab.
- Seventeen new interface strings in all eight languages.

### Fixed

- **Subtitles:** switching them off while a burned-in subtitle was playing left it in the picture
  while the interface already showed "Off". Switching back on did not work either.
- **Auto-play:** an explicitly chosen audio track could be lost when the next episode started by
  itself — the episode then played the file's default language.
- **Auto-play:** jumping to another chapter during the outro countdown no longer lets the next
  episode start anyway. The jump now cancels the countdown, same as a number-key jump.
- **Previous episode:** pressing it in the last moment of the outro countdown could land on the
  *next* episode instead.
- **Player:** closing the audio or subtitle panel could leave no visible focus and an unresponsive
  OK button for a few seconds.
- **Subtitles:** with external subtitles, long films put steady avoidable load on the TV — the
  full cue list was searched from the start several times per second.
- **Player:** the "ends at" time rebuilt a date formatter several times per second for the whole
  film, for a value that changes once a minute.
- **Watch together:** switching library while partner data was still loading could filter the new
  library against the previous library's watched titles.
- **Watchlist:** if creating the playlist failed on the very first bookmark, the button stayed
  stuck showing "saved" and could not be used again until a restart.
- **Settings:** on a server that hides its public user list, opening Settings started an endless
  stream of requests.
- **Collections:** opening a collection from inside another collection made the Back button do
  nothing — the only way out was the sidebar.
- **Screensaver:** on the server and profile selection screens neither OcenFin's nor the TV's
  screensaver ran, so a bright static screen could stay on an OLED panel indefinitely.
- **Server load:** six list queries asked the server for a total count that was never used.

### Internal

- `CODE-HEALTH.md` §10 records the full review pass behind these fixes: eight independent review
  angles, every finding verified individually before being applied, plus seven structural
  refactors that were deliberately deferred.
- Corrected subtitle-delivery comments in `playback.js` that predated client-side ASS/PGS
  rendering, and completed the routing and storage-key lists in the project notes.

---

*Releases before this entry are not reconstructed here — see the
[GitHub releases](https://github.com/seluce/OcenFin/releases) for their notes.*
