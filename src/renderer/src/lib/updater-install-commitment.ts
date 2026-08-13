// Why: the installer replaces app.asar underneath every live renderer, so this has
// to be true in the dashboard popout too — it has its own JS context and its own
// lazy chunks read from the same archive.
//
// Main is the single source of truth, and preload — not this module — holds the
// subscription. Preload runs before any document script, so it cannot miss a
// broadcast; a React effect can, and could never recover it, because the async seed
// goes unanswered while the Linux package install blocks main inside spawnSync.
//
// There is deliberately no renderer-local "we started an install" bit. It could only
// arm the initiating window between dispatching its restart and main marking
// commitment — a window in which main has not yet invoked the installer, so the
// archive is still intact and nothing needs protecting. Two separate latch defects
// came from trying to keep that bit honest against aborts.

/** Main's view, buffered by preload since the document's first instant. */
export function isUpdaterInstallCommitted(): boolean {
  try {
    return window.api?.updater?.isInstallCommittedNow?.() === true
  } catch {
    // This is read from inside a chunk-failure path. A bridge that is gone or
    // mid-teardown must degrade to ordinary recovery, never replace one failure
    // with another.
    return false
  }
}
