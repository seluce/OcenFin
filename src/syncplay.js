// SyncPlay — Gruppen-Wiedergabe über Jellyfins /SyncPlay-API.
// Phase 1: Gruppen verwalten (auflisten/erstellen/beitreten/verlassen) per REST + Polling.
// Phase 2 (später): Echtzeit-Synchronisation der Wiedergabe über WebSocket-Kommandos.

import { authHeaders } from './utils.js';

// Ein Auth-Schema, eine Quelle: utils.authHeaders. Lokaler Alias bleibt, damit die
// vielen Aufrufstellen unverändert bleiben (headers(token) statt überall umzubauen).
const headers = (token) => authHeaders(token);

// Registriert die Sitzung als steuerbar — Voraussetzung dafür, dass SyncPlay die Sitzung
// in einer Gruppe ansprechen darf. Idempotent; einmal nach dem Login genügt.
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

// Verfügbare Gruppen inkl. Teilnehmer. Liefert [] bei Fehler.
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

// WebSocket-URL für Echtzeit-Updates (Gruppen-Status + Wiedergabe-Kommandos).
// http→ws, https→wss. Jellyfin schiebt darüber SyncPlayGroupUpdate / SyncPlayCommand.
export function syncSocketUrl(serverUrl, token, deviceId) {
  const base = serverUrl.replace(/^http/i, 'ws');
  return `${base}/socket?ApiKey=${encodeURIComponent(token)}&deviceId=${encodeURIComponent(deviceId)}`;
}

// ── Phase 2: Wiedergabe-Synchronisation ──────────────────────────────────────

// Gruppe so einstellen, dass der Server NICHT auf den Buffer-Handshake aller
// Clients wartet → Kommandos werden sofort verteilt. (Feinabstimmung = Phase 2b.)
export async function setSyncIgnoreWait(serverUrl, token, ignore = true) {
  try {
    await fetch(`${serverUrl}/SyncPlay/SetIgnoreWait`, {
      method: 'POST', headers: headers(token), body: JSON.stringify({ IgnoreWait: ignore }),
    });
    return true;
  } catch { return false; }
}

// Setzt die abzuspielende Gruppen-Queue (ein Item). Der Server verteilt daraufhin
// ein PlayQueue-Update an alle Mitglieder.
export async function setSyncQueue(serverUrl, token, itemId, startPositionTicks) {
  try {
    const res = await fetch(`${serverUrl}/SyncPlay/SetNewQueue`, {
      method: 'POST', headers: headers(token),
      body: JSON.stringify({ PlayingQueue: [itemId], PlayingItemPosition: 0, StartPositionTicks: startPositionTicks }),
    });
    return res.ok;
  } catch { return false; }
}

// Sendet ein lokales Steuer-Ereignis an die Gruppe. action: 'Pause' | 'Unpause' | 'Seek' | 'Stop'.
// Nur 'Seek' trägt eine Position; der Server verteilt das Kommando an alle (inkl. Absender).
export async function sendSyncCommand(serverUrl, token, action, positionTicks) {
  try {
    const body = action === 'Seek' ? JSON.stringify({ PositionTicks: positionTicks }) : undefined;
    const res = await fetch(`${serverUrl}/SyncPlay/${action}`, { method: 'POST', headers: headers(token), body });
    return res.ok;
  } catch { return false; }
}

// Puffer-Handshake (Phase 2b): „ich puffere/spule, bin NICHT bereit" → Gruppe wartet.
export async function sendSyncBuffering(serverUrl, token, positionTicks, isPlaying, playlistItemId) {
  try {
    await fetch(`${serverUrl}/SyncPlay/Buffering`, {
      method: 'POST', headers: headers(token),
      body: JSON.stringify({ When: new Date().toISOString(), PositionTicks: positionTicks, IsPlaying: isPlaying, PlaylistItemId: playlistItemId }),
    });
    return true;
  } catch { return false; }
}
// „ich bin bereit (an dieser Position)" → wenn alle bereit sind, gibt der Server die Wiedergabe frei (Unpause).
export async function sendSyncReady(serverUrl, token, positionTicks, isPlaying, playlistItemId) {
  try {
    await fetch(`${serverUrl}/SyncPlay/Ready`, {
      method: 'POST', headers: headers(token),
      body: JSON.stringify({ When: new Date().toISOString(), PositionTicks: positionTicks, IsPlaying: isPlaying, PlaylistItemId: playlistItemId }),
    });
    return true;
  } catch { return false; }
}
