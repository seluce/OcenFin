// App-wide source of truth for server URL, access token and connection status.
// $state object instead of writable stores: App writes the fields directly, components read
// session.serverUrl / session.token / session.connectionLost. No feed bridge, no timing lag —
// writes are immediately visible to all readers (shared reactive proxy).
export const session = $state({
  serverUrl: '',
  token: '',
  connectionLost: false,
});
