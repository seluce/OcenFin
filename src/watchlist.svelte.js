// Watchlist — a real per-user Jellyfin playlist with a fixed, language-independent
// internal name (WATCHLIST_NAME) so the app can find it again after a language switch;
// the UI shows a localized label instead (i18n.t.watchlist). The playlist is created
// lazily on the first add (POST /Playlists creates it together with the first item).
// Removal needs the PlaylistItemId (EntryId), not the item id → entries maps
// itemId → playlistItemId. Being a real playlist it also shows up in other clients.
import { session } from './session.svelte.js';
import { authHeaders } from './utils.js';

const WATCHLIST_NAME = 'Watchlist';

export const watchlist = $state({
  playlistId: null,
  entries: {},       // { [itemId]: playlistItemId }
  items: [],         // full playlist items — feeds the dashboard row reactively
});

let currentUserId = null;

function headers() { return authHeaders(session.token); }

// Find the user's watchlist playlist (by its fixed name) and load its members.
// Called by App whenever the active profile changes.
export async function initWatchlist(userId) {
  currentUserId = userId;
  watchlist.playlistId = null;
  watchlist.entries = {};
  watchlist.items = [];
  try {
    const res = await fetch(
      `${session.serverUrl}/Users/${userId}/Items?IncludeItemTypes=Playlist&Recursive=true&EnableTotalRecordCount=false`,
      { headers: headers() }
    );
    if (!res.ok) return;
    const d = await res.json();
    if (userId !== currentUserId) return;   // profile switched meanwhile → discard
    const pl = (d.Items || []).find(p => p.Name === WATCHLIST_NAME);
    if (!pl) return;                        // none yet → created lazily on the first add
    watchlist.playlistId = pl.Id;
    await refreshEntries(userId);
  } catch { /* watchlist is optional — the UI simply shows nothing as bookmarked */ }
}

// (Re)load the member list. The POST that adds an item does not return its EntryId,
// so after every add we re-fetch once to get the PlaylistItemId needed for removal.
async function refreshEntries(userId) {
  if (!watchlist.playlistId) return;
  const res = await fetch(
    `${session.serverUrl}/Playlists/${watchlist.playlistId}/Items?UserId=${userId}&Limit=500`,
    { headers: headers() }
  );
  if (!res.ok) return;
  const d = await res.json();
  if (userId !== currentUserId) return;
  const map = {};
  for (const it of (d.Items || [])) map[it.Id] = it.PlaylistItemId;
  watchlist.entries = map;
  watchlist.items = d.Items || [];
}

// An item counts as bookmarked if it is in the playlist itself OR (for series/seasons)
// if any stored entry belongs to it — series are stored as ONE representative episode.
// Called by App when a playlist is deleted in the UI. If it was the watchlist itself,
// clear the local state — otherwise the bookmark icons would keep answering from the
// stale in-memory entries until the next full re-init (app reload / profile switch).
export function handlePlaylistDeleted(playlistId) {
  if (!playlistId || playlistId !== watchlist.playlistId) return;
  watchlist.playlistId = null;
  watchlist.entries = {};
  watchlist.items = [];
}

export function inWatchlist(itemId) {
  if (watchlist.entries[itemId]) return true;
  return watchlist.items.some(it => it.SeriesId === itemId || it.SeasonId === itemId);
}

// Series/seasons cannot live in a playlist — the server would expand them into ALL of
// their episodes (playlists are playable queues). We store ONE representative episode
// instead: the next unwatched one, falling back to the first.
async function representativeEpisode(item, userId) {
  const urls = item.Type === 'Series'
    ? [`${session.serverUrl}/Shows/NextUp?SeriesId=${item.Id}&UserId=${userId}&Limit=1&EnableTotalRecordCount=false`,
       `${session.serverUrl}/Users/${userId}/Items?ParentId=${item.Id}&IncludeItemTypes=Episode&Recursive=true&Limit=1&SortBy=ParentIndexNumber,IndexNumber&EnableTotalRecordCount=false`]
    : [`${session.serverUrl}/Users/${userId}/Items?ParentId=${item.Id}&IncludeItemTypes=Episode&Filters=IsNotPlayed&Limit=1&SortBy=SortName&EnableTotalRecordCount=false`,
       `${session.serverUrl}/Users/${userId}/Items?ParentId=${item.Id}&IncludeItemTypes=Episode&Limit=1&SortBy=SortName&EnableTotalRecordCount=false`];
  for (const url of urls) {
    try {
      const res = await fetch(url, { headers: headers() });
      if (res.ok) { const d = await res.json(); if (d.Items?.length) return d.Items[0]; }
    } catch { }
  }
  return null;
}

// Toggle membership. Remove is optimistic; for add the icon flips immediately via a
// placeholder entry, then the refresh replaces it with the real PlaylistItemId.
export async function toggleWatchlist(item) {
  const userId = currentUserId;
  if (!userId || !item?.Id) return;
  // Everything that belongs to this item: itself, or (for series/seasons) its representative episode(s).
  const related = watchlist.items.filter(it => it.Id === item.Id || it.SeriesId === item.Id || it.SeasonId === item.Id);
  try {
    if (related.length) {
      // Remove — optimistic; a series/season may own several entries, delete them all at once.
      const ids = related.map(it => it.PlaylistItemId).filter(Boolean);
      watchlist.items = watchlist.items.filter(it => !related.includes(it));
      for (const it of related) delete watchlist.entries[it.Id];
      if (ids.length)
        await fetch(`${session.serverUrl}/Playlists/${watchlist.playlistId}/Items?EntryIds=${ids.join(',')}`,
          { method: 'DELETE', headers: headers() });
    } else if (!watchlist.entries[item.Id]) {
      watchlist.entries[item.Id] = 'pending';   // instant icon feedback; refresh replaces it
      let target = item;
      if (item.Type === 'Series' || item.Type === 'Season') {
        target = await representativeEpisode(item, userId);
        if (!target) { delete watchlist.entries[item.Id]; return; }   // series without episodes
      }
      if (watchlist.playlistId) {
        await fetch(`${session.serverUrl}/Playlists/${watchlist.playlistId}/Items?Ids=${target.Id}&UserId=${userId}`,
          { method: 'POST', headers: headers() });
      } else {
        // First ever add: creating the playlist and adding the item is one call.
        const res = await fetch(
          `${session.serverUrl}/Playlists?Name=${encodeURIComponent(WATCHLIST_NAME)}&Ids=${target.Id}&UserId=${userId}`,
          { method: 'POST', headers: headers() });
        if (res.ok) watchlist.playlistId = (await res.json()).Id;
      }
      // The refresh rebuilds entries (dropping the pending marker) and items — for a
      // series the SeriesId match in inWatchlist takes over seamlessly.
      await refreshEntries(userId);
    }
  } catch {
    // Network error → re-sync with the server so the UI doesn't lie.
    refreshEntries(userId);
  }
}
