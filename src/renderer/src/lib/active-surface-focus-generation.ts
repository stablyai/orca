// Cmd-J focus routines run asynchronously across animation frames — the editor
// path retries for ~0.5s while a lazy Monaco chunk mounts, the terminal path
// double-rAFs for the xterm commit. Without coordination, a still-running loop
// from an earlier navigation can land focus on the previous destination after a
// newer jump already focused its surface (e.g. a stale editor retry stealing
// focus from a freshly-focused terminal). This shared, monotonically increasing
// token lets each async focus request detect that a newer request — for ANY
// surface type — has superseded it and bail. Living in its own module keeps the
// per-surface focus modules free of cross-imports (no dependency cycle).
let generation = 0

// Call at the start of a focus request; the returned token identifies it.
export function beginActiveSurfaceFocus(): number {
  generation += 1
  return generation
}

// True while `token` is still the most recent focus request.
export function isActiveSurfaceFocusCurrent(token: number): boolean {
  return token === generation
}
