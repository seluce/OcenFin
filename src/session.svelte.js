// App-weite Quelle der Wahrheit für Server-URL, Zugangstoken und Verbindungsstatus.
// $state-Objekt statt writable Stores: App schreibt die Felder direkt, Komponenten lesen
// session.serverUrl / session.token / session.connectionLost. Keine Feed-Brücke, kein Timing-Lag —
// Schreibzugriffe sind sofort für alle Leser sichtbar (geteilter reaktiver Proxy).
export const session = $state({
  serverUrl: '',
  token: '',
  connectionLost: false,
});
