// Why a private-field probe: xterm exposes no public disposed flag, and
// write() on a disposed instance silently DROPS its completion callback — no
// throw, no event (verified against the vendored 6.1.0-beta.287). That silent
// drop is the invisible producer behind zombie panes: restore writes routed
// into a disposed instance leave zero trace of any kind. This probe exists to
// name that moment in breadcrumbs. `_core._store._isDisposed` is the only
// field that flips on dispose in the vendored build; the test pins it so a
// vendored upgrade that moves the field fails loudly instead of silently
// blinding the instrumentation.
export function isXtermInstanceDisposed(terminal: unknown): boolean {
  const core = (terminal as { _core?: { _store?: { _isDisposed?: unknown } } } | null)?._core
  return core?._store?._isDisposed === true
}
