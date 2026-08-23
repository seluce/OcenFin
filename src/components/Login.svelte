<script>
  // ============================================================
  // LOGIN / ONBOARDING — server selection, discovery, profile choice,
  // password / manual / Quick Connect sign-in.
  //
  // Deliberately lazy-loaded (App: lazyLogin) — the auto-login path
  // never mounts this component. All flow state lives here and
  // dies with the unmount; a profile/server switch mounts fresh.
  //
  // App keeps the long-lived truths: session, selectedServer,
  // users (Settings needs the list), savedServers/savedTokens
  // (startup / quick switch / shared profile) and finishLogin.
  // This component reports results via narrow callbacks.
  // ============================================================
  import { onDestroy } from 'svelte';
  import { i18n } from '../i18n.svelte.js';
  import { session } from '../session.svelte.js';
  import { focusOnMount, dlog } from '../utils.js';

  let {
    phase = $bindable('servers'), // 'servers' | 'users' — App controls the entry point (startup/profile switch/logout)
    server = null,                // currently connected server (App-owned; feeds session.serverUrl there)
    users = [],                   // public profiles (App-owned — Settings needs the list later)
    savedServers = [],            // saved servers (App-owned — startup reads them for auto-login)
    clientAuthHeader = '',        // auth header without a user reference (Quick Connect Initiate)
    authHeaderFor,                // (name) => auth header with a user-specific DeviceId
    getStoredToken,               // (serverId, userId) => token | undefined (quick switch)
    onValidateToken,              // (token) => Promise<boolean>
    onServerConnected,            // (server) => void — App sets selectedServer
    onFetchUsers,                 // () => Promise<void> — fills users (App state)
    onSaveServer,                 // (server) => void — append + persist
    onRemoveServer,               // (id) => void — remove + delete this server's tokens
    onRenameServer,               // (id, name) => void — server name adopted from the server
    onTokenRefreshed,             // (serverId, userId, token) => void — App updates only when saving is active
    onSwitchServer,               // () => void — back to the server selection (App: handleLogout)
    onDone,                       // (user, token) => void — App: finishLogin
  } = $props();

  // ── Flow state: lives only here and ends with the unmount ──
  let serverConnectError = $state('');
  let isConnecting       = $state(false);
  let showAddServer      = $state(false); // "Add new server" panel
  let isDiscovering      = $state(false);
  let discoveredServers  = $state([]);
  let newServerUrl       = $state('');
  let pendingServer      = $state(null);  // entry currently connecting (spinner / retry / error back)
  let pendingUser        = $state(null);  // profile the password is being requested for
  let showPasswordForm   = $state(false);
  let showManualLogin    = $state(false);
  let manualUsername     = $state('');
  let manualPassword     = $state('');
  let loginError         = $state('');
  let password           = $state('');
  let qcCode    = $state(null);
  let qcQrSvg   = $state(null);
  let qcSecret  = null;
  let qcPolling = null;

  // Entry directly on the profile choice (profile switch or expired auto-login token):
  // users can be empty then → load once.
  $effect(() => { if (phase === 'users' && server && users.length === 0) onFetchUsers?.(); });

  // QC polling never outlives the view (login success or switch unmounts the component)
  onDestroy(() => clearInterval(qcPolling));

  /** Back key, called by App.handleGlobalBack (pattern like Collection.handleBackKey):
   *  true = consumed here (sub-dialog closed), false = App goes to the server selection. */
  export function handleBackKey() {
    if (showPasswordForm || showManualLogin || qcCode) {
      showPasswordForm = false;
      showManualLogin  = false;
      if (qcCode) cancelQuickConnect();
      return true;
    }
    return false;
  }

  // ============================================================
  // SERVER DISCOVERY
  // ============================================================

  async function getLocalIpViaWebRTC() {
    return new Promise((resolve) => {
      try {
        const pc = new RTCPeerConnection({ iceServers: [] });
        pc.createDataChannel('');
        pc.createOffer().then(o => pc.setLocalDescription(o));
        pc.onicecandidate = (e) => {
          if (!e?.candidate) { pc.close(); resolve(null); return; }
          const m = /([0-9]{1,3}(\.[0-9]{1,3}){3})/.exec(e.candidate.candidate);
          if (m && !m[1].startsWith('127.')) { pc.close(); resolve(m[1]); }
        };
      } catch { resolve(null); }
      setTimeout(() => resolve(null), 3000);
    });
  }

  async function tryJellyfinServer(url) {
    const ctrl  = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 1500);
    try {
      const res = await fetch(`${url}/System/Info/Public`, { signal: ctrl.signal });
      if (res.ok) {
        const data = await res.json();
        return { url, name: data.ServerName || 'Jellyfin Server' };
      }
    } catch { } finally { clearTimeout(timer); }
    return null;
  }

  async function discoverJellyfinServers() {
    isDiscovering     = true;
    discoveredServers = [];

    const candidates = new Set([
      'http://jellyfin.local:8096',
      'https://jellyfin.local:8920',
      'http://localhost:8096',
    ]);

    const localIp = await getLocalIpViaWebRTC();
    if (localIp) {
      const subnet = localIp.split('.').slice(0, 3).join('.');
      for (const h of [1, 2, 3, 10, 50, 100, 101, 150, 200, 201, 250]) {
        if (!localIp.endsWith(`.${h}`)) candidates.add(`http://${subnet}.${h}:8096`);
      }
    } else {
      for (const s of ['192.168.0','192.168.1','192.168.2','10.0.0','10.0.1']) {
        for (const h of [1, 2, 100, 101]) candidates.add(`http://${s}.${h}:8096`);
      }
    }

    const results = await Promise.allSettled([...candidates].map(tryJellyfinServer));
    discoveredServers = results
      .filter(r => r.status === 'fulfilled' && r.value)
      .map(r => r.value)
      .filter(d => !savedServers.find(s => s.url === d.url)); // filter out already saved ones

    isDiscovering = false;
  }

  // ============================================================
  // CONNECT / ADD SERVER
  // ============================================================

  async function connectToServer(srv) {
    pendingServer      = srv;
    onServerConnected?.(srv);   // App: selectedServer = srv → $effect.pre feeds session.serverUrl
    serverConnectError = '';
    isConnecting       = true;
    loginError         = '';
    showPasswordForm   = false;
    showManualLogin    = false;

    try {
      const ctrl  = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 6000);
      const res   = await fetch(`${srv.url}/System/Info/Public`, { signal: ctrl.signal });
      clearTimeout(timer);

      if (res.ok) {
        const data = await res.json();
        // Update the server name if it changed
        if (data.ServerName && data.ServerName !== srv.name) {
          onRenameServer?.(srv.id, data.ServerName);
        }
        await onFetchUsers?.();
        phase         = 'users';
        showAddServer = false;
      } else {
        serverConnectError = i18n.t.errInvalid;
      }
    } catch (e) {
      console.warn('[Server] connection failed:', e);
      serverConnectError = i18n.t.errOffline;
    } finally {
      isConnecting = false;
    }
  }

  // Probe /System/Info/Public with a short timeout; returns the response only on a 2xx answer.
  async function probeServer(url, ms = 4000) {
    const ctrl  = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms);
    try { const r = await fetch(`${url}/System/Info/Public`, { signal: ctrl.signal }); return r.ok ? r : null; }
    catch { return null; } finally { clearTimeout(timer); }
  }

  // An http:// URL that was DISCOVERED (or typed with the scheme by habit) may well have an https
  // counterpart. Ask the server once, at the moment one is actually chosen — the LAN scan itself
  // stays fast and http-only, and this costs a single round trip for the one server being kept.
  // Two candidates, probed in parallel so the wait is one timeout and not two: the same port
  // (Jellyfin behind a proxy that serves both) and 8920 (Jellyfin's own https port). The same port
  // wins if both answer, since that is what was actually found. Returns the original URL unchanged
  // when nothing answers — an http server stays http, it simply gets the badge.
  async function upgradeToHttps(url) {
    const m = url.match(/^http:\/\/([^/]+)$/i);
    if (!m) return url;
    const host = m[1].replace(/:\d+$/, '');
    const port = m[1].match(/:(\d+)$/)?.[1];
    const candidates = [];
    if (port) candidates.push(`https://${host}:${port}`);
    if (port !== '8920') candidates.push(`https://${host}:8920`);
    if (!candidates.length) candidates.push(`https://${host}`);
    const hits = await Promise.all(candidates.map(c => probeServer(c, 2500).then(r => r ? c : null)));
    return hits.find(Boolean) || url;
  }

  // Turn what the user typed into a concrete server URL. A bare host (no scheme) is tried over
  // HTTPS FIRST and only falls back to HTTP if that does not answer — so the encrypted default no
  // longer depends on the user knowing to type "https://". An explicit scheme is always honoured:
  // someone who deliberately typed http:// (a server with no cert) is not overridden.
  // What to try for an input without a scheme, in order of preference. Jellyfin almost never sits
  // on 443/80, so appending a scheme alone would probe the two ports it is least likely to answer
  // on. Whatever the user DID supply always wins: an explicit port is used verbatim.
  //   host:port  → exactly that, https first
  //   1.2.3.4    → 8920 (Jellyfin https) then 8096 (Jellyfin http); an IP rarely has a proxy
  //   my.domain  → 443 first (a reverse proxy on a real domain is the common case), then 8920,
  //                then the plain ports — a domain is the one case where 443/80 are plausible
  function schemeCandidates(input) {
    if (/:\d+$/.test(input))                       return { https: [`https://${input}`], http: [`http://${input}`] };
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(input))     return { https: [`https://${input}:8920`], http: [`http://${input}:8096`] };
    return { https: [`https://${input}`, `https://${input}:8920`],
             http:  [`http://${input}:8096`, `http://${input}`] };
  }

  // First reachable candidate from a list, probed in PARALLEL so the wait is one timeout rather
  // than one per candidate; list order decides which wins when several answer.
  async function firstReachable(urls) {
    const hits = await Promise.all(urls.map(u => probeServer(u, 3000).then(r => r ? { url: u, res: r } : null)));
    return hits.find(Boolean) || null;
  }

  async function resolveServer(cleanUrl) {
    if (/^https?:\/\//i.test(cleanUrl)) {
      // Explicit http:// — from the discovery list or typed out of habit. Offer the encrypted
      // counterpart before committing; if there is none, keep exactly what was asked for.
      const target = cleanUrl.startsWith('http://') ? await upgradeToHttps(cleanUrl) : cleanUrl;
      const res = await probeServer(target);
      if (res) return { url: target, res };
      if (target === cleanUrl) return null;
      const orig = await probeServer(cleanUrl);          // upgrade probe raced us — fall back
      return orig ? { url: cleanUrl, res: orig } : null;
    }
    const { https, http } = schemeCandidates(cleanUrl);
    return (await firstReachable(https)) || (await firstReachable(http));
  }

  async function addAndConnectServer(url) {
    if (!url.trim()) return;
    const cleanUrl = url.trim().replace(/\/$/, '');

    // Fast path: the exact input, or it with a scheme, is already a saved server.
    const known = (u) => savedServers.find(s => s.url === u);
    const existing = known(cleanUrl) || known('https://' + cleanUrl) || known('http://' + cleanUrl);
    if (existing) { await connectToServer(existing); return; }

    serverConnectError = '';
    isConnecting       = true;
    try {
      const hit = await resolveServer(cleanUrl);
      if (hit) {
        // Resolution may have filled in a port or upgraded the scheme — check again before saving,
        // otherwise typing "192.168.1.5" would add a second entry for a server already stored as
        // https://192.168.1.5:8920.
        const already = known(hit.url);
        if (already) { await connectToServer(already); newServerUrl = ''; return; }
        const data = await hit.res.json();
        const srv  = { id: 'srv_' + Date.now(), url: hit.url, name: data.ServerName || 'Jellyfin Server' };
        onSaveServer?.(srv);
        await connectToServer(srv);
        newServerUrl = '';
      } else {
        serverConnectError = i18n.t.errOffline;
      }
    } catch (e) {
      console.warn('[Server] connection failed:', e);
      serverConnectError = i18n.t.errOffline;
    } finally {
      isConnecting = false;
    }
  }

  // ============================================================
  // SIGN-IN
  // ============================================================

  /** Profile clicked — quick sign-in via a saved token if available */
  async function handleUserClick(user) {
    loginError      = '';
    password        = '';
    pendingUser     = user;
    showManualLogin = false;

    if (!user.HasPassword) {
      await authenticateUser(user.Name, '');
      return;
    }

    const storedToken = getStoredToken?.(server?.id, user.Id);
    if (storedToken) {
      if (await onValidateToken?.(storedToken)) {
        onDone?.(user, storedToken);
        return;
      } else {
        // Token rejected: do NOT delete the entry — it represents the user's wish to save.
        // After a successful password sign-in, App refreshes it via onTokenRefreshed.
        dlog('[auth] stored token rejected for', user.Name, '— save preference kept, refreshed after password login');
      }
    }

    // Show the password entry
    showPasswordForm = true;
  }

  async function authenticateUser(username, pw) {
    loginError = '';
    try {
      const res = await fetch(`${session.serverUrl}/Users/AuthenticateByName`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': authHeaderFor(username) },
        body:    JSON.stringify({ Username: username, Pw: pw })
      });
      if (res.ok) {
        const data = await res.json();
        // Refresh the saved token — whether saving is active is checked by App
        onTokenRefreshed?.(server?.id, data.User.Id, data.AccessToken);
        onDone?.(data.User, data.AccessToken);
      } else {
        loginError = i18n.t.errLogin;
      }
    } catch { loginError = i18n.t.errOffline; }
  }

  // Quick Connect — login flow (code on the TV, confirmed on the phone)
  async function startQuickConnect() {
    clearInterval(qcPolling);   // a double press must not orphan the previous poll — the TV app
    qcPolling = null;           // never reloads, so an untracked 3 s interval would run for days
    loginError = '';
    showPasswordForm = false;
    showManualLogin  = false;
    try {
      const res = await fetch(`${session.serverUrl}/QuickConnect/Initiate`, {
        headers: { 'Authorization': clientAuthHeader }
      });
      if (res.ok) {
        const data = await res.json();
        qcCode   = data.Code;
        qcSecret = data.Secret;
        // QR that opens the Jellyfin web Quick Connect page with the code pre-filled — a phone that
        // is already signed in to the web client then only has to confirm, no typing of the code.
        try {
          const { renderSVG } = await import('uqr');
          qcQrSvg = renderSVG(`${session.serverUrl}/web/#/quickconnect?code=${encodeURIComponent(data.Code)}`, { ecc: 'M', border: 1 });
        } catch (e) { console.warn('[OcenFin] QC QR generation failed', e); qcQrSvg = null; }
        qcPolling = setInterval(async () => {
          try {
            const poll = await fetch(`${session.serverUrl}/QuickConnect/Connect?Secret=${qcSecret}`, {
              headers: { 'Authorization': clientAuthHeader }
            });
            if (!poll.ok) return;   // code expired or server hiccup — keep polling, don't throw
            const pd   = await poll.json();
            if (pd.Authenticated) {
              clearInterval(qcPolling);
              const authRes = await fetch(`${session.serverUrl}/Users/AuthenticateWithQuickConnect`, {
                method:  'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': clientAuthHeader },
                body:    JSON.stringify({ Secret: qcSecret })
              });
              if (authRes.ok) {
                const authData = await authRes.json();
                qcCode = qcQrSvg = null;
                qcSecret = null;   // consumed — don't leave a usable secret in memory
                onDone?.(authData.User, authData.AccessToken);
              }
            }
          } catch { }
        }, 3000);
      } else {
        loginError = i18n.t.qcError;
      }
    } catch { loginError = i18n.t.networkError; }
  }

  function cancelQuickConnect() {
    clearInterval(qcPolling);
    qcCode = qcSecret = qcQrSvg = null;
  }
</script>

<!-- ============================================================
     PHASE: SERVER SELECTION
============================================================ -->
{#if phase === 'servers'}
  <div class="h-full flex items-center justify-center p-8">
    <div class="w-full max-w-2xl flex flex-col gap-6">

      <div class="text-center mb-2">
        <h1 class="text-4xl font-bold text-blue-500 mb-1">{i18n.t.title}</h1>
        <p class="text-gray-400">{i18n.t.serverSelectPrompt}</p>
      </div>

      <!-- Saved servers + error message: own focus group -->
      <div data-focus-group="servers" class="flex flex-col gap-6">

      <!-- Saved servers -->
      {#if savedServers.length > 0}
        <div class="flex flex-col gap-3">
          <p class="text-sm text-gray-400 uppercase tracking-wider font-bold ml-1">{i18n.t.savedServers}</p>
          {#each savedServers as server, i (server.id)}
            <div class="flex items-center gap-3">
              <button
                onclick={() => connectToServer(server)}
                {@attach focusOnMount(i === 0)}
                class="flex-1 flex items-center justify-between p-5 bg-gray-800 hover:bg-gray-700 focus:bg-gray-700
                       border border-gray-600 hover:border-blue-500 focus:border-blue-500
                       rounded-xl text-left focus:outline-none focus:ring-2 focus:ring-blue-500 transition-all"
              >
                <div class="overflow-hidden">
                  <span class="text-xl font-bold text-white block truncate">{server.name}</span>
                  <span class="text-sm text-gray-400 block mt-0.5 truncate">{server.url}{#if server.url.startsWith('http://')}<span title={i18n.t.insecureHttpHint} class="ml-2 inline-block px-1.5 py-0.5 rounded bg-yellow-900/70 text-yellow-300 text-[0.65rem] font-bold align-middle">HTTP</span>{/if}</span>
                </div>
                {#if isConnecting && pendingServer?.id === server.id}
                  <div class="w-6 h-6 border-2 border-blue-400 border-t-transparent rounded-full animate-spin shrink-0 ml-4"></div>
                {:else}
                  <svg class="w-6 h-6 text-blue-400 shrink-0 ml-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7"/>
                  </svg>
                {/if}
              </button>
              <!-- Remove server -->
              <button
                onclick={() => onRemoveServer?.(server.id)}
                class="p-3 text-gray-600 hover:text-red-400 focus:text-red-400 focus:outline-none focus:ring-2 focus:ring-red-500 rounded-lg transition-colors"
                title={i18n.t.backToServers}
              >
                <svg class="w-6 h-6" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/>
                </svg>
              </button>
            </div>
          {/each}
        </div>
      {/if}

      <!-- Error message + retry -->
      {#if serverConnectError}
        <div class="bg-red-900/40 border border-red-700 rounded-xl p-5 flex flex-col gap-4">
          <div class="flex items-center gap-3">
            <svg class="w-6 h-6 text-red-400 shrink-0" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/>
            </svg>
            <p class="text-red-300 font-semibold text-lg">{serverConnectError}</p>
          </div>
          <div class="flex gap-3">
            <button
              onclick={() => pendingServer && connectToServer(pendingServer)}
              {@attach focusOnMount()}
              class="flex-1 bg-gray-700 hover:bg-gray-600 focus:bg-gray-600 text-white font-bold py-3 rounded-lg
                     focus:outline-none focus:ring-2 focus:ring-white transition-colors"
            >
              {i18n.t.serverRetry}
            </button>
            <button
              onclick={() => { serverConnectError = ''; pendingServer = null; }}
              class="flex-1 bg-transparent border border-gray-600 hover:bg-gray-800 focus:bg-gray-800 text-gray-300 font-bold py-3 rounded-lg
                     focus:outline-none focus:ring-2 focus:ring-white transition-colors"
            >
              {i18n.t.backToServers}
            </button>
          </div>
        </div>
      {/if}

      </div><!-- end focus group "servers" -->

      <!-- "Add server" flow (toggle + panel): own group; entry always on the toggle,
           so Up/Down cleanly runs toggle → discovery → manual (rather than pitting the full-width
           toggle against the indented panel). -->
      <div data-focus-group="addserver" data-enter-first class="flex flex-col gap-6">

      <!-- Add new server (toggle panel) -->
      <button
        onclick={() => { showAddServer = !showAddServer; if (showAddServer) discoverJellyfinServers(); }}
        class="w-full flex items-center justify-center gap-3 py-4 rounded-xl border-2 transition-all
               focus:outline-none focus:ring-4 focus:ring-blue-300 font-bold text-lg
               {showAddServer ? 'bg-gray-800 border-blue-600 text-blue-400' : 'bg-transparent border-gray-700 text-gray-400 hover:border-blue-500 hover:text-blue-400'}"
      >
        <svg class="w-6 h-6 transition-transform {showAddServer ? 'rotate-45' : ''}" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" d="M12 4v16m8-8H4"/>
        </svg>
        {showAddServer ? i18n.t.qcCancel : i18n.t.addServer}
      </button>

      {#if showAddServer}
        <div class="bg-gray-800 border border-gray-700 rounded-xl p-6 flex flex-col gap-5">

          <!-- Discovery -->
          <button
            onclick={discoverJellyfinServers}
            disabled={isDiscovering}
            class="w-full flex items-center justify-center gap-3 bg-blue-600 hover:bg-blue-500 disabled:bg-blue-900
                   text-white font-bold text-lg py-4 rounded-xl focus:outline-none focus:ring-4 focus:ring-blue-300 transition-colors"
          >
            {#if isDiscovering}
              <div class="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin"></div>
              {i18n.t.discovering}
            {:else}
              <svg class="w-6 h-6" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" d="M8.111 16.404a5.5 5.5 0 017.778 0M12 20h.01m-7.08-7.071c3.904-3.905 10.236-3.905 14.141 0M1.394 9.393c5.857-5.857 15.355-5.857 21.213 0"/>
              </svg>
              {i18n.t.discoverServers}
            {/if}
          </button>

          <!-- Discovered (new) servers -->
          {#if discoveredServers.length > 0}
            <div class="flex flex-col gap-2">
              <p class="text-xs text-gray-400 uppercase tracking-wider font-bold">{i18n.t.serverFound}</p>
              {#each discoveredServers as d (d.url)}
                <button
                  onclick={() => addAndConnectServer(d.url)}
                  class="flex items-center justify-between p-4 bg-gray-900 hover:bg-gray-700 focus:bg-gray-700
                         border border-gray-600 hover:border-blue-500 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500 transition-all text-left"
                >
                  <div>
                    <span class="text-lg font-bold text-white block">{d.name}</span>
                    <span class="text-sm text-gray-400">{d.url}</span>
                  </div>
                  <svg class="w-5 h-5 text-blue-400" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M12 4v16m8-8H4"/>
                  </svg>
                </button>
              {/each}
            </div>
          {/if}

          <!-- Divider -->
          <div class="flex items-center gap-3">
            <div class="flex-1 h-px bg-gray-700"></div>
            <span class="text-gray-500 text-sm">{i18n.t.serverManualEntry}</span>
            <div class="flex-1 h-px bg-gray-700"></div>
          </div>

          <!-- Manuelle URL -->
          <div class="flex gap-3">
            <input
              type="text"
              bind:value={newServerUrl}
              onkeydown={(e) => e.key === 'Enter' && addAndConnectServer(newServerUrl)}
              placeholder={i18n.t.serverAddressPlaceholder}
              class="flex-1 bg-gray-900 text-white text-lg p-4 rounded-xl border border-gray-600
                     focus:outline-none focus:ring-4 focus:ring-blue-500"
            />
            <button
              onclick={() => addAndConnectServer(newServerUrl)}
              disabled={!newServerUrl.trim() || isConnecting}
              class="bg-gray-700 hover:bg-gray-600 disabled:opacity-40 text-white font-bold px-6 rounded-xl
                     focus:outline-none focus:ring-4 focus:ring-white transition-colors"
            >
              {isConnecting ? '…' : 'OK'}
            </button>
          </div>

        </div>
      {/if}
      </div><!-- end focus group "addserver" -->

    </div>
  </div>

<!-- ============================================================
     PHASE: USER SELECTION
============================================================ -->
{:else if phase === 'users'}
  <div class="h-full flex items-center justify-center p-8">
    <div data-focus-group="users" class="w-full max-w-6xl flex flex-col items-center gap-10">

      <!-- Server name as context -->
      {#if server}
        <p class="text-gray-500 text-lg font-medium tracking-wide">
          {server.name} · <span class="text-gray-600">{server.url}</span>
        </p>
      {/if}

      <!-- QC login: show the code -->
      {#if qcCode}
        <div class="bg-gray-800 p-10 rounded-2xl shadow-xl w-full {qcQrSvg ? 'max-w-3xl' : 'max-w-xl'} text-center border border-gray-700">
          <h2 class="text-3xl font-bold text-white mb-8">{i18n.t.quickConnect}</h2>
          <div class="flex items-center justify-center gap-10 mb-8">
            <!-- Code method (left) -->
            <div class="flex-1 flex flex-col items-center gap-4">
              <div class="bg-gray-900 border-2 border-blue-500 rounded-lg py-6 px-6 w-full">
                <span class="text-6xl font-mono font-bold text-white tracking-widest">{qcCode}</span>
              </div>
              <p class="text-gray-400 text-base leading-snug">{i18n.t.qcInstruction}</p>
            </div>
            {#if qcQrSvg}
              <!-- QR method (right) -->
              <div class="flex flex-col items-center gap-3 shrink-0">
                <div class="rounded-xl bg-white p-3 [&>svg]:block [&>svg]:w-full [&>svg]:h-full"
                     style="width:240px;height:240px;">{@html qcQrSvg}</div>
                <p class="text-gray-400 text-base leading-snug max-w-[240px]">{i18n.t.qcQrHint}</p>
              </div>
            {/if}
          </div>
          <button onclick={cancelQuickConnect} {@attach focusOnMount()}
            class="w-full bg-gray-700 hover:bg-gray-600 text-gray-300 font-bold py-4 rounded-xl
                   focus:outline-none focus:ring-4 focus:ring-white transition-colors">
            {i18n.t.qcCancel}
          </button>
        </div>

      <!-- Password entry for the selected profile -->
      {:else if showPasswordForm && pendingUser}
        <div class="bg-gray-800 p-10 rounded-2xl shadow-xl max-w-xl w-full text-center border border-gray-700">
          <h2 class="text-3xl font-bold text-white mb-6">{i18n.t.passwordPrompt} {pendingUser.Name}</h2>
          <input
            type="password"
            bind:value={password}
            class="w-full bg-gray-900 text-white text-2xl p-5 rounded-xl mb-6 border border-gray-600 text-center
                   focus:outline-none focus:ring-4 focus:ring-blue-500"
            onkeydown={(e) => e.key === 'Enter' && authenticateUser(pendingUser.Name, password)}
            {@attach focusOnMount()}
          />
          <button onclick={() => authenticateUser(pendingUser.Name, password)}
            class="w-full bg-blue-600 hover:bg-blue-500 text-white font-bold text-xl py-4 rounded-xl mb-4
                   focus:outline-none focus:ring-4 focus:ring-white">
            {i18n.t.loginText}
          </button>
          <!-- Alternative: Quick Connect (if the password shouldn't be saved/typed) -->
          <button onclick={startQuickConnect}
            class="w-full flex items-center justify-center gap-2 bg-gray-700 hover:bg-gray-600 text-gray-200 font-bold text-lg py-3.5 rounded-xl mb-4
                   focus:outline-none focus:ring-4 focus:ring-white transition-colors">
            <svg class="w-5 h-5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z"/></svg>
            {i18n.t.quickConnect}
          </button>
          <button onclick={() => { showPasswordForm = false; pendingUser = null; }}
            class="w-full bg-gray-700/50 hover:bg-gray-600 text-gray-300 hover:text-white font-bold text-lg py-3.5 rounded-xl
                   focus:outline-none focus:ring-4 focus:ring-white transition-colors">
            {i18n.t.back}
          </button>
          {#if loginError}<p class="text-red-400 mt-4 font-semibold">{loginError}</p>{/if}
        </div>

      <!-- Manual sign-in -->
      {:else if showManualLogin}
        <div class="bg-gray-800 p-10 rounded-2xl shadow-xl max-w-xl w-full text-center border border-gray-700">
          <h2 class="text-3xl font-bold text-white mb-6">{i18n.t.manualLogin}</h2>
          <input
            type="text"
            bind:value={manualUsername}
            placeholder={i18n.t.username}
            onkeydown={(e) => e.key === 'Enter' && authenticateUser(manualUsername, manualPassword)}
            class="w-full bg-gray-900 text-white text-xl p-5 rounded-xl mb-4 border border-gray-600
                   focus:outline-none focus:ring-4 focus:ring-blue-500"
            {@attach focusOnMount()}
          />
          <input
            type="password"
            bind:value={manualPassword}
            placeholder={i18n.t.password}
            onkeydown={(e) => e.key === 'Enter' && authenticateUser(manualUsername, manualPassword)}
            class="w-full bg-gray-900 text-white text-xl p-5 rounded-xl mb-6 border border-gray-600
                   focus:outline-none focus:ring-4 focus:ring-blue-500"
          />
          <button onclick={() => authenticateUser(manualUsername, manualPassword)}
            class="w-full bg-blue-600 hover:bg-blue-500 text-white font-bold text-xl py-4 rounded-xl mb-4
                   focus:outline-none focus:ring-4 focus:ring-white">
            {i18n.t.loginText}
          </button>
          <button onclick={() => showManualLogin = false}
            class="w-full bg-gray-700/50 hover:bg-gray-600 text-gray-300 hover:text-white font-bold text-lg py-3.5 rounded-xl
                   focus:outline-none focus:ring-4 focus:ring-white transition-colors">
            {i18n.t.back}
          </button>
          {#if loginError}<p class="text-red-400 mt-4 font-semibold">{loginError}</p>{/if}
        </div>

      <!-- Profile selection -->
      {:else}
        <h1 class="text-5xl font-bold text-white">{i18n.t.selectUser}</h1>

        <!-- Profiles -->
        {#if users.length > 0}
          <div class="flex flex-wrap justify-center gap-10">
            {#each users as user, i (user.Id)}
              <button onclick={() => handleUserClick(user)} {@attach focusOnMount(i === 0)} class="flex flex-col items-center group focus:outline-none">
                <div class="w-44 h-44 rounded-2xl overflow-hidden border-4 border-transparent group-focus:border-white group-focus:scale-105 shadow-xl transition-transform duration-200">
                  {#if user.PrimaryImageTag}
                    <img src="{session.serverUrl}/Users/{user.Id}/Images/Primary?tag={user.PrimaryImageTag}&fillWidth=300&fillHeight=300&quality=90&format=webp" alt={user.Name} class="w-full h-full object-cover"/>
                  {:else}
                    <div class="w-full h-full bg-gray-700 flex items-center justify-center">
                      <span class="text-6xl font-bold">{user.Name.charAt(0)}</span>
                    </div>
                  {/if}
                </div>
                <span class="mt-4 text-2xl text-gray-400 group-focus:text-white transition-colors">{user.Name}</span>
              </button>
            {/each}
          </div>
        {/if}

        <!-- Divider -->
        <div class="flex items-center gap-4 w-full max-w-xl mt-4">
          <div class="flex-1 h-px bg-gray-800"></div>
          <span class="text-gray-600 text-sm">oder</span>
          <div class="flex-1 h-px bg-gray-800"></div>
        </div>

        <!-- Manual sign-in + Quick Connect buttons (like original Jellyfin) -->
        <div class="flex gap-4">
          <button
            onclick={() => { showManualLogin = true; loginError = ''; }}
            class="flex items-center gap-3 bg-gray-800 hover:bg-gray-700 focus:bg-gray-700
                   border border-gray-700 hover:border-gray-500 text-gray-300 hover:text-white
                   font-bold text-lg px-8 py-4 rounded-xl focus:outline-none focus:ring-4 focus:ring-white transition-all"
          >
            <svg class="w-6 h-6" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"/>
            </svg>
            {i18n.t.manualLogin}
          </button>

          <button
            onclick={startQuickConnect}
            class="flex items-center gap-3 bg-gray-800 hover:bg-gray-700 focus:bg-gray-700
                   border border-gray-700 hover:border-blue-500 text-gray-300 hover:text-blue-300
                   font-bold text-lg px-8 py-4 rounded-xl focus:outline-none focus:ring-4 focus:ring-blue-500 transition-all"
          >
            <svg class="w-6 h-6" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z"/>
            </svg>
            {i18n.t.quickConnect}
          </button>
        </div>

        <!-- Choose a different server -->
        <button
          onclick={onSwitchServer}
          class="text-gray-600 hover:text-gray-400 focus:text-gray-400 focus:outline-none text-sm font-medium mt-2"
        >
          ← {i18n.t.switchServer}
        </button>

        {#if loginError}<p class="text-red-400 font-semibold">{loginError}</p>{/if}
      {/if}

    </div>
  </div>
{/if}
