/** Setup-hold readers keyed by workspace, so a frame wakes the workspaces it changed, not every chat on the host. */
export function createWorkspaceSetupHoldListeners() {
  const byKey = new Map<string, Set<() => void>>()
  return {
    subscribe(key: string, listener: () => void): () => void {
      const keyed = byKey.get(key) ?? new Set()
      keyed.add(listener)
      byKey.set(key, keyed)
      return () => {
        keyed.delete(listener)
        if (keyed.size === 0 && byKey.get(key) === keyed) {
          byKey.delete(key)
        }
      }
    },
    /** Unknown (`null`) to or from an answer changes every workspace; otherwise only the diff. */
    notifyChanged(previous: ReadonlySet<string> | null, next: ReadonlySet<string> | null): void {
      if (previous === next) {
        return
      }
      const changed =
        previous === null || next === null
          ? [...byKey.keys()]
          : [...previous, ...next].filter((key) => previous.has(key) !== next.has(key))
      for (const key of changed) {
        for (const listener of byKey.get(key) ?? []) {
          listener()
        }
      }
    }
  }
}
