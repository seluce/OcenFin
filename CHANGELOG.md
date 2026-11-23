# Changelog

Notable changes to OcenFin. Versions are release dates (`YYYY.MM.DD`) and match
`public/appinfo.json` as well as the version shown under Settings → Status.

## Unreleased

### Added

- **Parental PIN.** Once a profile with an age limit has been used, the profiles without one ask for a four-digit PIN,
  and so do that profile's settings; set it under Profile & Account.

### Changed

- **Screen saver settings in profiles with an age limit.** The screen saver belongs to each profile now, so these
  profiles can choose their own again.

## 2026.11.22

### Added

- **Genres and director on the title page.** A quiet line above the plot names them, as the library's info preview
  already did for the genres.
- **The whole plot on the title page.** Where the description is cut short, you can select it and OK shows all of it,
  split into paragraphs so a long one reads easily.
- **Episode pages say which episode they are.** Season and episode number and the air date stand next to the runtime.
- **Series pages with their years and seasons.** They show "2013 – today" or "2013 – 2016" and the number of seasons,
  as the cards already did, instead of an episode's running time.
- **Time left on a started title.** Its page says how many minutes remain, next to the time it would end.
- **The home banner with the title page's details.** Its line now shows a series' years and seasons, a film's running
  time, the age rating, both ratings and the genres, just as the title page and the library's info preview do.
- **How a title will play, before you press Play.** Media info says whether the chosen version, audio and subtitle play
  directly or get converted, and why; the audio and subtitle lists mark the tracks that would convert or burn in.

### Changed

- **Quicker steps from title to title, most of all in large libraries.** Each move takes the TV less work on every
  screen, and a library answers a thousand titles down as quickly as at its top, where it used to slow with every page.
- **Quicker start.** Of the twenty languages on board, the app now prepares only the one it shows.
- **Home banner together with the first rows.** It no longer waits for the watch history before it looks for titles,
  so its placeholder is gone at the same moment as the rest.
- **A slightly taller home banner.** The picture behind the featured title gets a little more room.
- **Episode details in the player stay readable.** Series, season and "Episode 2 of 8" at the top now stand out
  over bright scenes too, as do the times at the bottom, thanks to a stronger, even shade behind the controls.
- **Media info in more detail.** It names the Dolby Vision profile, bit depth, exact frame rate, the audio's sample
  rate and the file, and writes sizes and tracks the way the rest of the app does.
- **Title pages complete sooner.** Seasons, episodes and suggestions now load together with the title instead of
  after it. The start, the settings and the way back onto a card also get focus as soon as there is something to focus.
- **Search results without the wait for people.** Titles show as soon as they are found, and matching people
  follow below them.
- **Info preview waits for your first move.** A freshly opened library no longer shows the box on its first title by
  itself, so a single Back leaves it again.
- **Versions you can tell apart.** A title with several versions lists each with its name and picture format, and two
  that would still read the same with their size.
- **Audio and subtitle lists start with your languages.** On the title page and in the player alike; on the title page
  they now open over the page instead of pushing it down.
- **Readable audio and subtitle names.** Each track shows its language in the app's language, forced or SDH and its
  format, instead of the file's jumble of codec words and repeated languages.
- **Episode numbers written one way.** Cards, search, playlists and the player's next-episode notice all read S1:E2,
  and a double episode shows both its numbers everywhere.
- **A series' years on every card.** Search, collections, favourites and person pages show "2013 – today" like the
  library, instead of the first year only.
- **Watched ticks in search and favourites.** Search results and favourite episodes now show the tick and the progress
  bar like every other card.
- **One size for every switch in the settings.** Content and Navigation had smaller rows than the other categories;
  now every switch looks like the rest, with a line between each two.
- **Age rating filter for every rating system.** It offers the ratings your titles actually carry: every spelling of
  an age as one number, and letter ratings such as PG-13 or TV-MA in a row of their own.
- **Every dialog darkens the screen the same way.** They used four shades and the exit question a blur; now all use
  one, and the card menu and the small pickers in the settings fade in like the other dialogs.

### Fixed

- **No half-watched titles in the home banner.** When the server answered in a certain order, a title from Continue
  watching could turn up in the banner as well.
- **Title pages with one actor in several roles open again.** Such a page, common with anime, kept loading forever;
  the person now shows once, with all their roles.
- **Continue watching keeps up with "watched".** A series or season marked as watched on its page or in a card's menu
  now takes its episode out of the row at once, instead of leaving it there with a tick until the app restarts.
- **Focus stays put when a card leaves the home screen.** Back onto a title that has just been finished or marked
  as watched now lands on the card next to it.
- **Focus back on the card after the playlist picker.** Closing the playlist or collection picker opened from a
  card's menu now returns to the card instead of leaving nothing selected.
- **Big titles keep the bottoms of their letters.** On title pages, collections, person pages, in the library and the
  player, the lower part of g, p and y was cut off; it now shows in full, with everything in the same place.
- **Back in the profile menu keeps a selection.** Closing the menu now returns to the profile picture instead of
  leaving nothing selected.
- **A title without a poster shows an empty frame.** Its page showed only a thin line where the picture would be.
- **An empty library shows its own icon.** It used to show the filter symbol even with no filter set.
- **Age ratings from NFO files read cleanly.** A title page shows "FSK 12" instead of the long list of spellings some
  NFO files store.

### Internal

- **Lighter requests.** Every list asks the server only for the pictures its cards show, and the info preview's
  plots come without watched states and artwork it never uses.
- **Fewer requests, checked against Jellyfin 12.4.** The automatic sign-in, the home screen's suggestions and a
  library's genre list each ask the server once where they asked twice, and nothing the app sends is outdated there.
- **Less repeated code.** Shared pieces for the person card, dialogs, settings switches, the time of day, favourite
  and watched marks and the backdrop preview replace copies spread over many screens.

## 2026.11.19

### Added

- **Info preview in the library.** Two seconds on a title show its rating, genres and plot next to the poster, and
  single steps with the arrows then take the box along from title to title; it can be switched off in the settings.

### Fixed

- **Outlined subtitles readable on the TV.** With the outline style, the black edge covered most of each letter
  on webOS 25; it now runs around the letters, as it always did in a desktop browser.

### Internal

- **Updated ASS subtitle engine.** JASSUB 2.5.38 brings a newer libass that lays out text faster and reads damaged
  subtitle files more safely.
- **Menu and hints follow only a moving pointer.** A precaution from testing webOS 26's browser engine, where a
  pointer that had not moved could open the menu at start; LG's own webOS 26 simulator does not do this.
- **Updated Svelte.** Svelte 5.58.0 brings small fixes to the order in which the interface updates itself; nothing
  changes on screen.

## 2026.11.17

### Added

- **Mark earlier episodes as watched.** For a series started in the middle or partly watched elsewhere, the
  menu of an episode or a season marks every episode before it in one go, leaving specials out.
- **Brazilian Portuguese.** A language of its own in the menu, next to European Portuguese, and a TV set to
  Portuguese (Brazil) starts in it.
- **The next film of a collection.** At the credits of a film that belongs to a collection, a card offers the
  next part, the same card as for the next episode, but a film never starts on its own.
- **Interface size in five steps.** The setting now goes from 80 to 120 percent in steps of ten, with a step
  between each of the old small, medium and large.
- **Skipping back and forward on their own, faster when held.** ◄► now jump as far as set, with separate
  steps for back and forward, and held down they scrub faster the longer they are held.
- **Graphite accent.** A neutral grey next to the ten colours, for an interface without any colour.
- **Subtitle size in five steps.** From very small to very large, with a step between normal and each end; a
  size chosen before stays as it was.
- **Height of text subtitles.** Four steps from lowest to higher; at the lowest, two lines fit into the black
  bar of very wide films.
- **Subtitles only for foreign-language audio.** With a subtitle language chosen, a new switch shows them only
  when the audio is in another language, and otherwise just the forced ones, as Jellyfin's "Smart" mode does.
- **Home screen rows in your own order.** Under Settings → Content → Home screen the rows move the same way as
  the menu entries, and each can still be switched off there; only the banner stays on top.
- **Subtitle preview.** Under Settings → Subtitles, choosing a style option opens a small window for a few seconds
  in which a sample line turns from the old look into the new one, over a coast at sunset drawn so that every
  style shows its difference.
- **Reset settings.** Next to Clear cache under Settings → Profile & Account, one button puts every setting of your
  profile back to its default after asking; the language, watch together and the saved password stay.
- **Screen saver preview.** A last row in the screen saver settings starts it right away with what you chose; any
  key ends it.
- **Favourites and watchlist in the gallery.** The screen saver's pictures can now come from the titles you marked
  yourself; the four sources sit in two rows, and random titles are the new default.

### Changed

- **Settings in a clearer order.** Content now covers the home screen, library and details page, theme music and
  watch together included; the clock moved to Appearance, the logo to Navigation, and the two account
  categories became one, Profile & Account.
- **Gallery screen saver straight away.** It stays black for the moment the first picture needs and then fades
  into it, instead of showing the clock first; the clock only stands in when there are no pictures.
- **Screen saver per profile.** Each profile chooses its own, or switches it off and lets the TV's screen saver take
  over; what was set so far stays with every profile, a new one starts fresh.
- **No clock in place of an empty gallery.** If the chosen source has nothing yet, such as no favourites or nothing
  watched, the gallery shows random titles instead.
- **No still picture from a single title.** If the chosen source holds just one title, it takes turns with random
  ones, so the picture keeps changing.

### Fixed

- **"Recently watched" without repeats.** A series you are in the middle of stood there and under "Up next" at
  the same time; the row now keeps to what you finished, and the rest stays in the rows above.
- **Screensaver times all in minutes.** The choices read 1 min, 90 sec, 2 min and 5 min; the second one is now
  1.5 min, written the way the language writes decimals.
- **The full subtitle track of the chosen language.** When a film has the language twice, the full track now
  wins over the forced one, which often comes first and only translates signs and foreign lines.
- **White text readable on every accent colour.** Buttons and labels in emerald, amber, sky, teal and orange
  are a little deeper now, and a focused button no longer turns paler.
- **The accent colour everywhere.** The glow around the seek bar's handle and a small text in the screensaver
  settings stayed blue, whatever colour was chosen.
- **A film is called a film in the player.** Playing a collection with "Play all", the countdown, the end card
  and the buttons spoke of the next episode; they now say film.
- **Collections in the right order.** A film series is listed and played by release date, or in the order set
  on the server, instead of alphabetically, which put part 3 of a trilogy before part 2.
- **Trailers in the app's language.** When Jellyfin knows several trailers for a title, the one whose name
  says the app's language plays, instead of always the first, which was often an older English one.
- **Sharing a season or an episode names the series.** The share dialog shows the series above "Season 2" or
  "S2:E1 · title", and the QR code opens that season's or episode's own page instead of just the series.
- **Buttons on a details page stay on one line.** "From start" and "Shuffle" no longer break into
  two or three lines in longer languages; at the larger interface sizes the round buttons move to a second row
  if needed.

## 2026.11.14

### Added

- **Czech, Hungarian, Romanian, Swedish, Danish, Norwegian, Finnish, Turkish, Ukrainian, Russian and
  Korean.** OcenFin now speaks nineteen languages, and the new ones can also be picked as preferred audio
  and subtitle language and in the subtitle search.

### Changed

- **Language lists fit on one screen.** The interface, audio and subtitle language pickers show every
  language at once in four columns, sorted by each language's own name.

### Fixed

- **Cyrillic text in the chosen font.** Russian or Ukrainian subtitles and titles now use Arimo, Noto Sans
  or Tinos when one of them is picked, instead of a mix with the TV's font.
- **Counts read right.** A person's page says "1 episode" instead of "1 episodes", and Polish uses its
  own forms for two to four and for five and more.
- **Translations read more naturally.** All languages were checked: clumsy or wrong wording is fixed,
  names match Jellyfin's web app (Quick Connect included), and minutes are abbreviated the same way everywhere.
- **Clear selection in pick lists.** The current choice stays blue and the highlighted entry gets a white
  frame, as everywhere else in Settings, so two entries no longer look selected at once.

### Internal

- **Updated libraries.** The styled subtitle engine (ASS) draws noticeably faster and handles its
  memory more safely; Vite and Tailwind bring bug fixes.

## 2026.11.02

### Changed

- **Library filters stay set.** Each library now remembers its filters like its sort order, even after
  a restart, and the filter menu has a button to reset them all.

### Fixed

- **Films kept together in one folder show up one by one.** A library with films in a shared folder,
  such as all Harry Potter films in one, showed that folder as a single tile that led nowhere; every
  film now has its own tile, as in Jellyfin's web app. The same goes for series.
- **DVD subtitles no longer stay empty in some films.** When the server had packed two subtitle
  pictures together, the whole track showed nothing; the updated image subtitle engine reads them.

## 2026.10.31

### Added

- **Send the log to your server.** The log viewer can now send the whole log, up to 1000 lines, to
  your Jellyfin server, where an administrator opens it in the dashboard; the QR code only holds the
  last few lines.

### Changed

- **The Magic Remote pointer moves the focus.** Pointing at a card or button now highlights it, and the
  arrow keys carry on from there instead of from where you were before.

### Fixed

- **The pointer stays visible in the player while its controls are shown.** It was hidden over the
  whole player, so the buttons had to be hit blind.

### Internal

- **Preparing for webOS 26.** With the diagnostic log switched on, the app also notes a few details
  about the TV's browser and remote, to compare before and after the update.
- **Updated libraries.** Svelte, hls.js and Vite bring bug fixes, and the image subtitle engine now
  also adjusts when a video changes its resolution during playback.

## 2026.10.19

### Changed

- **The home banner keeps changing with "Reduce animations".** It now moves on to the next title as a
  plain cut instead of standing still; only the fade is left out.

### Fixed

- **Down from Back lands on Play.** On a title page it used to skip the play button and jump to the
  episodes or cast below; Up from there now comes back to the buttons as well.
- **The menu logo lines up.** With the menu closed, the logo now sits centred above the profile
  picture and the icons instead of slightly to the left.
- **Only playable libraries in the menu.** Books, home videos and photos, and the server's folder
  view no longer show up, as nothing in them could be played.
- **Continue watching shows only videos.** An audiobook or e-book started in another Jellyfin app no
  longer appears there.

### Internal

- **Updated ASS subtitle engine.** JASSUB 2.5.23 draws ASS subtitles with less work per frame and
  also finds fonts in a file that carry no family name.
- **A fresh README.** New screenshots of the current app, using the Blender Foundation's open movies
  as demo data; they now live in the repository instead of on an external host.

## 2026.10.11

**This release needs Jellyfin Server 12.2 or newer.** On 12.0 or 12.1 it runs, but DVD subtitles stay
empty.

### Changed

- **ASS subtitles look exactly as made.** "ASS/SSA in their original look" now draws them with libass,
  the reference renderer, using the fonts inside the file; switching between ASS tracks is instant.
- **One corner for a card's status.** Top right now shows the time or episodes left, or a green tick
  once you have seen it all, instead of a tick, a count and a full bar at once.
- **"Episode count" is now "Unwatched episodes".** Series in the library show how many episodes are
  still left instead of their total.

### Fixed

- **Focus frame in the subtitle settings.** The frame around "Remember subtitle per series" is no
  longer cut off at its bottom corners.
- **DVD subtitles show up.** They used to stay empty; the TV now draws them itself, just like
  Blu-ray subtitles.

### Internal

- **Updated picture-subtitle library.** libbitsub 1.13.0 also stops a subtitle download that is no
  longer needed when you switch tracks.
- **Updated build tools.** Svelte 5.57.2 and Vite 8.3.4, both patch releases with bug fixes only.
- **Current webOS calls.** Leaving the app uses LG's documented way for apps with their own exit
  question, and a launcher setting that webOS ignores is gone.
- **License notes in the README.** It now lists every component the app ships, from hls.js to the
  subtitle libraries and fonts, together with its license.

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
