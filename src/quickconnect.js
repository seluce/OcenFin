// Quick Connect — a code appears on the TV, someone confirms it on a device that is already signed
// in, and the server hands back a token for THAT account. Extracted from Login.svelte because the
// watch-together picker needs the identical flow: copying it would have been the eighth duplicated
// mechanism this week.
//
// The important property for watch together: the TV never picks the account. Whoever confirms the
// code decides which profile is granted, on their own device, without their password ever being
// typed on the TV or known to the person setting it up. AuthenticateWithQuickConnect returns the
// User alongside the token, so the identity is the server's word rather than a typed name.
import { dlog } from './utils.js';

const POLL_MS = 3000;

/**
 * Starts a Quick Connect attempt.
 *
 * @param serverUrl        base URL of the Jellyfin server
 * @param clientAuthHeader auth header WITHOUT a user reference (Initiate/Connect need this)
 * @param onCode           called with ({ code, qrSvg }) once the server issued a code; qrSvg may be
 *                         null when the QR could not be rendered — the code alone still works
 * @returns { promise, cancel } — promise resolves with { user, token } after confirmation, or
 *          rejects with 'qcError' (server refused / Quick Connect disabled) or 'networkError'.
 *          cancel() stops the polling and makes the promise reject with 'cancelled'.
 *
 * The caller MUST call cancel() when its dialog goes away. The TV app runs for days without a
 * reload, so an unattended 3 s interval would outlive the screen that started it — the reason the
 * previous inline version could orphan a poll on a double press.
 */
export function startQuickConnect(serverUrl, clientAuthHeader, onCode) {
  let timer = null;
  let secret = null;
  let settled = false;
  // Declared BEFORE the promise: the executor runs synchronously and assigns this, so declaring it
  // afterwards would hit the temporal dead zone.
  let cancelRef = () => {};

  const stop = () => { if (timer) { clearInterval(timer); timer = null; } secret = null; };

  const promise = new Promise((resolve, reject) => {
    const finish = (fn, arg) => { if (settled) return; settled = true; stop(); fn(arg); };

    (async () => {
      let data;
      try {
        const res = await fetch(`${serverUrl}/QuickConnect/Initiate`, { headers: { 'Authorization': clientAuthHeader } });
        if (!res.ok) return finish(reject, 'qcError');
        data = await res.json();
      } catch { return finish(reject, 'networkError'); }
      if (settled) return;                                  // cancelled while Initiate was in flight

      secret = data.Secret;
      // QR opens the Jellyfin web Quick Connect page with the code already filled in — a phone that
      // is signed in to the web client then only has to confirm, no typing.
      let qrSvg = null;
      try {
        const { renderSVG } = await import('uqr');
        qrSvg = renderSVG(`${serverUrl}/web/#/quickconnect?code=${encodeURIComponent(data.Code)}`, { ecc: 'M', border: 1 });
      } catch (e) { console.warn('[OcenFin] QC QR generation failed', e); }
      if (settled) return;
      onCode?.({ code: data.Code, qrSvg });

      timer = setInterval(async () => {
        try {
          const poll = await fetch(`${serverUrl}/QuickConnect/Connect?Secret=${secret}`, {
            headers: { 'Authorization': clientAuthHeader }
          });
          if (!poll.ok) return;            // code expired or server hiccup — keep polling, don't throw
          const pd = await poll.json();
          if (!pd.Authenticated) return;
          const authRes = await fetch(`${serverUrl}/Users/AuthenticateWithQuickConnect`, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': clientAuthHeader },
            body:    JSON.stringify({ Secret: secret })
          });
          if (!authRes.ok) return finish(reject, 'qcError');
          const authData = await authRes.json();
          dlog('[auth] quick connect confirmed for', authData.User?.Name);
          finish(resolve, { user: authData.User, token: authData.AccessToken });
        } catch { /* transient — the next tick tries again */ }
      }, POLL_MS);
    })();

    // Rejecting on cancel keeps the promise from dangling forever.
    cancelRef = () => finish(reject, 'cancelled');
  });

  return { promise, cancel: () => cancelRef() };
}
