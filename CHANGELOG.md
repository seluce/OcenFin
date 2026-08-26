# Changelog

Notable changes to OcenFin. Versions are release dates (`YYYY.MM.DD`) and match
`public/appinfo.json` as well as the version shown under Settings → Status.

## 2026.08.26

### Fixed

- **Back from a cast member's page now returns you to where you were with the remote's Back key
  too.** The on-screen button already did: back into the search results, the library or the list you
  came from, on the entry you had opened. The remote's own key took a shortcut past all of that and
  only changed the view, so the search came back with nothing focused and the next press opened the
  menu instead of moving within the results. Both do the same thing now.
- **A collection or watchlist opens on its first title instead of on the Back button.** Returning to
  one from a title already put you back on the entry you had opened, but opening one fresh left
  focus sitting on Back — so the first press of the remote led straight out of the list you had just
  asked for. It now starts on the first title, the way favourites already did, and falls back to the
  Back button only when there is nothing in the list.
- **A collection inside a collection steps back one level at a time.** Opening one from within
  another and pressing Back brought you to the parent with nothing focused, so the next press of the
  remote opened the menu; pressing Back once more then aimed at the nested collection instead of at
  the title you had originally opened, and landed somewhere else on the page or at the top of it.
  Every level now keeps its own place: you return to the collection you went into, at the position
  you left it, and the last step back takes you to where the chain started.
- **Picking a term from the search history no longer leaves the remote stranded.** The list of past
  searches disappears the moment a term is chosen — together with the button you had just pressed,
  so nothing on screen held focus and the next press of the remote opened the menu instead of moving
  into the results that had meanwhile arrived. Focus now moves on to the first result, or back to
  the search field when the term finds nothing. Emptying the history does the same.
- **Editing a playlist keeps the remote working.** Removing an entry took the button you pressed
  down with its row, and moving an entry all the way to the top or bottom greyed out the very arrow
  you were on — both left the page without focus, so the next press jumped to the menu. Removing now
  lands on the entry that moved up into the gap, so a series of deletions works from the same spot,
  and an entry that reaches the end hands focus to the opposite arrow.
- **Leaving a title returns you into a filtered library properly.** With a filter active — say
  favourites only — taking the favourite off inside the title and going back correctly dropped it
  from the list, but left focus nowhere at all, so the next press opened the menu. Focus now lands
  on the title that moved up into the gap, at the place on the page you left.
- **Opening a title from a cast member's page no longer strands you.** From a title you could reach
  a cast member, and from there another title — but Back then returned to the second title instead
  of the first, and from that point on it only ever alternated between that title and the cast
  member. The page you started from could not be reached again, and Back never left at all; the menu
  was the only way out. Every step back now returns where it came from.
- **Going back to the home screen from a library, search, favourites or the settings puts you back
  on the page.** All four returned to a home screen with nothing focused, so the next press of the
  remote opened the menu instead of moving within the page. A library now returns you to the tile
  you opened it from, and the other three to the first row of the page.
- **Choosing the settings from the menu now moves you into them.** Focus stayed on the menu entry,
  because the settings load on demand and were not on screen yet at the moment focus was handed
  over — so the bar stayed open over the page until you pressed again.
- **A cast member's page remembers where you were.** Opening one of their titles and coming back put
  you on the Back button with the page scrolled to the top; with a hundred titles listed that meant
  finding your place again every time. It now returns to the title you opened, at the position you
  left, and opening a person fresh starts on their first title.
- **The remote keeps working after a playback error.** If a title failed to start and you chose "try
  again", playback resumed but OK and the arrow keys did nothing — the button you had just pressed
  disappeared with the message and took the focus with it, leaving the remote with no target inside
  the player. Only Back still responded, which meant leaving the title to get the remote back.
- **After watching, a title page puts you back on its play button.** Having reached the title
  through a cast member's page, it came back focused on that actor instead.
- **Choosing a symbol for a menu entry no longer strands the remote.** Picking one — or leaving the
  chooser with Back — left the settings with nothing focused, so the next press opened the menu
  instead of continuing where you were. Focus returns to the entry you were editing.
- **Lists in the settings open on the setting you actually have.** The language, font, theme and
  seek-step choosers started at the top of the list, which for a long list meant scrolling down to
  find what was already selected. They now open on it.
- **Removing a saved server keeps the remote working.** The ✕ takes its own row with it, and unless
  it was the first server in the list that left the sign-in screen with nothing focused — the one
  place in the app with no menu to fall back on. Focus now moves to the next server down, or to "add
  server" once the list is empty. That ✕ also called itself "Back to Selection"; it says "Remove".
- **Leaving the password entry returns you to the profile you picked**, instead of to the first one
  in the row.
- **Typing a server address by hand no longer opens the on-screen keyboard unasked.** Passing over
  the field on the way to its OK button was enough to bring the keyboard up; it now opens on OK, the
  way the fields in the settings do. Entering a password is unchanged — there the keyboard comes
  straight up, which is what you want.
- **The word "or" on the profile screen was German in every language.** It is translated now.
- **Theme music follows the title you are actually looking at.** Jumping from a series to another
  title through "more like this" kept the first one's theme playing under the new page. It now
  changes with the page — the new title's own theme, or silence when it has none, which is also what
  a lookup that fails now falls back to. Stepping through a series to a season or an episode still
  keeps the theme running without restarting it, as before.
- **Marking a title watched or a favourite applies to the title you are on.** After reaching it
  through "more like this", the tick or the heart was additionally written onto the title you had
  originally opened — so the wrong card showed as watched in the library, or the wrong film appeared
  in favourites. The server always got the right one; only the card behind you was wrong.
- **Opening a library from the home screen lands on its first title.** Picking Films, Series or
  Playlists under "My media" took you into the library but left nothing focused, so the first press
  of the remote opened the menu instead of moving through the titles — the same tile chosen from the
  menu did it right. Both ways in behave the same now, including opening a library you were just in.

## 2026.08.25

### Added

- **Connecting prefers HTTPS, and fills in the rest.** Type as little as `192.168.1.100` or
  `jellyfin.example.com` — the app works out the scheme and the port for you, trying the encrypted
  connection first. It looks in the places Jellyfin actually lives: port 8920 for HTTPS and 8096 for
  HTTP, and for a domain name port 443 first, since that is usually where a reverse proxy sits.
  Anything you do type wins — give a port and it is used as-is, write `http://` on purpose and that
  is respected.
- **A server found by the automatic search is upgraded to HTTPS if it offers it.** The search itself
  still scans over HTTP so it stays quick; the server you actually pick is then asked once whether
  it also answers encrypted, and is saved that way if it does.
- **Settings are trimmed down on a profile with an age restriction.** Screen saver, account and
  server, diagnostics, and the sign-in credentials are hidden, while everything that shapes
  watching — appearance, content, navigation, remote, playback, subtitles — and the profile picture
  stay. Note this tidies the interface rather than locking anything: it holds only as far as the
  other profiles have passwords.
- **Servers reached over unencrypted HTTP are marked** with a small amber **HTTP** badge in the
  server list and in the settings — a reminder that on that connection your password and access
  token travel the network in the clear. See the FAQ on certificates for what to do about it.

### Changed

- **Going back from a title to the home screen returns you to where you were.** Libraries already
  did this; the home screen did not — it came back scrolled to the top with nothing focused, so the
  next press of the remote opened the menu instead of moving within the page. It now returns to the
  card you opened — the exact one, even when the same title is showing in several rows at once, for
  instance in Continue watching and on the watchlist. If you navigate on in the meantime, your own
  focus is kept.
- **Back inside a title's page steps back one level.** Opening a season from a series, an episode
  from a season, or another title from "more like this" and pressing Back left the page altogether
  and dropped you on the home screen or in the library. It now returns to the page you came from,
  and only leaves once there is nothing left to step back to — with the remote's Back key and the
  on-screen button alike, landing on the season, episode or cast member you had selected, and at the
  place on the page you left rather than back at the top. Coming back from a suggested title starts
  at the top of the page, since that row is fetched late and would otherwise pull you down to it
  after the fact.
- **Search keeps its results while you look at one of them.** Opening a title or a person from the
  search results and coming back used to leave an empty field: the query, the results and how far
  you had scrolled were all thrown away, and finding the next result meant searching again. It now
  returns to the list exactly where you left it. Opening Search from the menu still starts blank, as
  a search screen should. And once something is typed, a small **✕** appears at the right of the
  field to empty it in one press — no more holding Backspace on the remote to get rid of a long
  entry. Reach it by pressing Right past the end of the text.
- **The same is now true for favourites, collections and watchlists.** Favourites always jumped back
  to the very first entry, and a collection or watchlist put you on its Back button instead of on
  the title you had just looked at. Opening a watchlist and leaving it again also lost the spot
  entirely. All three now return you to where you were — including how far you had scrolled, and
  including favourite people. If that entry is gone in the meantime, the first one takes over.
- **The app now opens on your first library instead of on the menu.** Starting the app used to put
  focus on the menu entry you were on, which unfolded the sidebar over the artwork before you had
  done anything. Focus now lands on the first tile of "My media"; hide that row and it moves to the
  first row you do show. The menu stays closed and is one press of Left away, as everywhere else.
  It still waits for the home screen and never takes focus away from you: press a key while it is
  loading and your own focus is kept, and a home screen with nothing to focus falls back to the
  menu as before.
- **"Recently added series" no longer arrives ten seconds late.** The row was fetched through an
  endpoint that takes the server about ten seconds to answer for series, while the identical request
  for movies came back in half a second. Asking for the same thing a simpler way returns the same
  titles in about a fifth of a second, so the row is now there with the rest of the page — and the
  movies row is built the same way, so both are quick and both mean the same thing.
- **The home screen's featured banner appears sooner.** Its two requests waited for the home
  screen's first answers although they never needed them, which put the banner three server round
  trips away on a cold start where the rest of the page needed one. They now go out immediately,
  behind the two requests that release the rest of the screen. One round trip gone.
- **Opening the sidebar is a little smoother.** The highlight behind the current entry cast a soft
  glow, and because the bar changes width as it opens, the TV had to redraw that blur on every
  single frame of the animation. The glow is gone; the entry is now flat blue. Nothing else about
  the sidebar changed.
- **Watch together asks the server far less.** Two scans were running over the same data: the
  dashboard read each partner's whole catalogue for its suggestions, and every library you opened
  read it again to know what to hide. The suggestion scan already covers every library, so the
  filter now takes what it needs from that instead of asking again — with two partners and three
  libraries, six requests become two. Partners are also fetched side by side rather than one after
  the other, which roughly halves the wait before a library appears filtered. What you see is
  unchanged.

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
- **Removing a server or signing out now really ends the access.** Until now only the local copy of
  the login was thrown away — on the Jellyfin side it stayed valid, and the TV kept showing up under
  Dashboard → Devices as a working entry forever. The app now tells the server the login is
  finished with. Logins you deliberately kept ("remember me", and the linked watch-together
  profiles) are left alone, so those keep working as before.
- **Removing a server now clears all of its saved tokens**, including the ones kept for watch
  together; leftovers from very old versions are cleaned up too. **Quick Connect** no longer leaves
  a login code active in the background after a successful sign-in.
- **Watch together can now be set up with Quick Connect.** Instead of typing the other person's
  password on the TV, the TV shows a code and they confirm it on their own phone — their password
  never leaves their device, and they decide for themselves. It also reaches hidden profiles, since
  no profile list is involved.
- **Hidden profiles can now be added to watch together.** They never show up in the profile list,
  so there was no way to pick them — the sign-in screen has had a manual entry for that case all
  along, and the picker now offers it too. Name and password, checked by the server as usual.
- **The password prompt now appears whenever the server asks for one**, instead of relying on what
  the profile list reported. A profile with a password could previously end up showing a generic
  sign-in error with no way to enter it.
- **Watch together says something when a profile needs signing in again.** If one of the two linked
  profiles lost its sign-in, the filter quietly carried on with the other one alone and showed more
  titles than it should have. It now tells you once which profile needs attention.

- **Group playback keeps in step even when the TV's clock is off.** Every SyncPlay instruction
  carries the server's time, and the app compared it against the television's own clock — so a set
  running a few seconds fast or slow paused and resumed that much early or late, with the whole
  group drifting apart. The difference between the two clocks is now measured and accounted for.
- **Turning on title logos no longer makes the details page jump around.** A logo's height depends
  on its shape — a wide wordmark is short, a stacked emblem tall — so the description and play
  buttons used to sit somewhere different on every title. The title area now keeps a steady height.
- **A damaged settings file can no longer stop the app from starting.** If stored settings ended up
  in an unexpected form — a half-written value after a power cut, a leftover from a much older
  version — the app could fail on startup or flash the screensaver continuously, with no way to
  clear it from the TV. Such values are now recognised and replaced with their defaults.
- **Destructive buttons no longer flare up when focus passes over them.** Sign out, clearing the
  log and leaving a group turned the most saturated red in the palette the moment they were
  focused — and on the remote, focus crosses a button on the way somewhere else rather than out of
  intent. They now carry their red quietly and all the time, so you can see what a button does
  before landing on it. White text on them went from 4.8:1 to 13.8:1 in the process.
- **Scrolling a large library asks the server for less.** The queries that fetch the next and the
  previous page still had the server count the whole library each time, although nothing used that
  number — the same needless work that was cleaned up elsewhere in the last release, missed in the
  two hottest queries. The dashboard's series lookup had it too.
- **Small text is easier to read from the sofa.** The faint grey used for details under posters —
  year, season, "today" — and throughout the status page fell below the accepted contrast minimum,
  which is felt most at the smallest interface size. It is brighter now, while still clearly
  secondary to the title above it.

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
