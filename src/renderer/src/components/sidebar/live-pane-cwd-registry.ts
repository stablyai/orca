/**
 * Live shell cwd reported by confirmed OSC 7, keyed by paneKey.
 * Why: agent rows need worktree-mismatch labels without polling getCwd (lsof)
 * for every sidebar card. OSC 7 is already parsed for split inheritance; this
 * registry mirrors confirmed values for React subscribers.
 */

let version = 0
const cwdByPaneKey = new Map<string, string>()
const listeners = new Set<() => void>()

function notify(): void {
  version += 1
  for (const listener of listeners) {
    listener()
  }
}

export function setLivePaneCwd(paneKey: string, cwd: string): void {
  const trimmed = cwd.trim()
  if (!trimmed) {
    clearLivePaneCwd(paneKey)
    return
  }
  if (cwdByPaneKey.get(paneKey) === trimmed) {
    return
  }
  cwdByPaneKey.set(paneKey, trimmed)
  notify()
}

export function clearLivePaneCwd(paneKey: string): void {
  if (!cwdByPaneKey.delete(paneKey)) {
    return
  }
  notify()
}

export function getLivePaneCwd(paneKey: string): string | undefined {
  return cwdByPaneKey.get(paneKey)
}

export function getLivePaneCwdMap(): ReadonlyMap<string, string> {
  return cwdByPaneKey
}

export function getLivePaneCwdVersion(): number {
  return version
}

export function subscribeLivePaneCwd(onStoreChange: () => void): () => void {
  listeners.add(onStoreChange)
  return () => {
    listeners.delete(onStoreChange)
  }
}

/** Test-only: drop all entries without bumping if already empty. */
export function resetLivePaneCwdRegistryForTests(): void {
  if (cwdByPaneKey.size === 0) {
    return
  }
  cwdByPaneKey.clear()
  notify()
}
