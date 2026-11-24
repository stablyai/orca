// Disposed xterm silently drops write callbacks (6.1.0-beta.287), freezing restore without errors. No public flag exists; probe _core._store._isDisposed for breadcrumbs and pin it in tests so upgrades cannot silently blind diagnostics.
export function isXtermInstanceDisposed(terminal: unknown): boolean {
  const core = (terminal as { _core?: { _store?: { _isDisposed?: unknown } } } | null)?._core
  return core?._store?._isDisposed === true
}
