// SyncPlay — group playback via Jellyfin's /SyncPlay API.
// Phase 1: manage groups (list/create/join/leave) via REST + polling.
// Phase 2 (later): real-time playback synchronization via WebSocket commands.

import { authHeaders } from './utils.js';

// One auth scheme, one source: utils.authHeaders. The local alias stays so the
// many call sites remain unchanged (headers(token) instead of rewriting everywhere).
const headers = (token) => authHeaders(token);

// Registers the session as controllable — a prerequisite for SyncPlay to address the session
// within a group. Idempotent; once after login is enough.
export async function registerSession(serverUrl, token) {
  try {
    await fetch(`${serverUrl}/Sessions/Capabilities/Full`, {
      method: 'POST',
      headers: headers(token),
      body: JSON.stringify({
        PlayableMediaTypes: ['Video', 'Audio'],
        SupportedCommands: ['PlayState', 'Play', 'DisplayMessage'],
        SupportsMediaControl: true,
        SupportsPersistentIdentifier: true,
      }),
    });
    return true;
  } catch { return false; }
}

// Available groups incl. participants. Returns [] on error.
export async function listSyncGroups(serverUrl, token) {
  try {
    const res = await fetch(`${serverUrl}/SyncPlay/List`, { headers: headers(token) });
    if (!res.ok) return [];
    return await res.json();   // [{ GroupId, GroupName, Participants: [name], LastUpdatedAt }]
  } catch { return []; }
}

export async function createSyncGroup(serverUrl, token, groupName) {
  try {
    const res = await fetch(`${serverUrl}/SyncPlay/New`, {
      method: 'POST', headers: headers(token), body: JSON.stringify({ GroupName: groupName }),
    });
    return res.ok;
  } catch { return false; }
}

export async function joinSyncGroup(serverUrl, token, groupId) {
  try {
    const res = await fetch(`${serverUrl}/SyncPlay/Join`, {
      method: 'POST', headers: headers(token), body: JSON.stringify({ GroupId: groupId }),
    });
    return res.ok;
  } catch { return false; }
}

export async function leaveSyncGroup(serverUrl, token) {
  try {
    const res = await fetch(`${serverUrl}/SyncPlay/Leave`, { method: 'POST', headers: headers(token) });
    return res.ok;
  } catch { return false; }
}

// WebSocket URL for real-time updates (group status + playback commands).
// http→ws, https→wss. Jellyfin pushes SyncPlayGroupUpdate / SyncPlayCommand over it.
export function syncSocketUrl(serverUrl, token, deviceId) {
  const base = serverUrl.replace(/^http/i, 'ws');
  return `${base}/socket?ApiKey=${encodeURIComponent(token)}&deviceId=${encodeURIComponent(deviceId)}`;
}

// ── Phase 2: playback synchronization ────────────────────────────────────────

// Configure the group so the server does NOT wait for the buffer handshake of all
// clients → commands are distributed immediately. (Fine-tuning = phase 2b.)
export async function setSyncIgnoreWait(serverUrl, token, ignore = true) {
  try {
    await fetch(`${serverUrl}/SyncPlay/SetIgnoreWait`, {
      method: 'POST', headers: headers(token), body: JSON.stringify({ IgnoreWait: ignore }),
    });
    return true;
  } catch { return false; }
}

// Sets the group queue to play (one item). The server then distributes
// a PlayQueue update to all members.
export async function setSyncQueue(serverUrl, token, itemId, startPositionTicks) {
  try {
    const res = await fetch(`${serverUrl}/SyncPlay/SetNewQueue`, {
      method: 'POST', headers: headers(token),
      body: JSON.stringify({ PlayingQueue: [itemId], PlayingItemPosition: 0, StartPositionTicks: startPositionTicks }),
    });
    return res.ok;
  } catch { return false; }
}

// Sends a local control event to the group. action: 'Pause' | 'Unpause' | 'Seek' | 'Stop'.
// Only 'Seek' carries a position; the server distributes the command to all (incl. the sender).
export async function sendSyncCommand(serverUrl, token, action, positionTicks) {
  try {
    const body = action === 'Seek' ? JSON.stringify({ PositionTicks: positionTicks }) : undefined;
    const res = await fetch(`${serverUrl}/SyncPlay/${action}`, { method: 'POST', headers: headers(token), body });
    return res.ok;
  } catch { return false; }
}

// Buffer handshake (phase 2b): "I'm buffering/seeking, NOT ready" → the group waits.
export async function sendSyncBuffering(serverUrl, token, positionTicks, isPlaying, playlistItemId) {
  try {
    await fetch(`${serverUrl}/SyncPlay/Buffering`, {
      method: 'POST', headers: headers(token),
      body: JSON.stringify({ When: new Date().toISOString(), PositionTicks: positionTicks, IsPlaying: isPlaying, PlaylistItemId: playlistItemId }),
    });
    return true;
  } catch { return false; }
}
// "I'm ready (at this position)" → when all are ready, the server releases playback (Unpause).
export async function sendSyncReady(serverUrl, token, positionTicks, isPlaying, playlistItemId) {
  try {
    await fetch(`${serverUrl}/SyncPlay/Ready`, {
      method: 'POST', headers: headers(token),
      body: JSON.stringify({ When: new Date().toISOString(), PositionTicks: positionTicks, IsPlaying: isPlaying, PlaylistItemId: playlistItemId }),
    });
    return true;
  } catch { return false; }
}
