// App-wide source of truth for server URL, access token and connection status.
// $state object instead of writable stores: App writes the fields directly, components read
// session.serverUrl / session.token / session.connectionLost. No feed bridge, no timing lag —
// writes are immediately visible to all readers (shared reactive proxy).
export const session = $state({
  serverUrl: '',
  token: '',
  connectionLost: false,
  // Server answered 401 for a request made with THIS token — it is no longer valid (device
  // revoked in the Jellyfin dashboard, password changed, account deleted, server restored from a
  // backup). Deliberately separate from connectionLost: unreachable means "wait", invalid means
  // "sign in again", and the two must never share a banner.
  authLost: false,
});
