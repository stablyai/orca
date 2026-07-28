type PendingTerminalTabSpawn = {
  result: Promise<string | null>
  resolve: (ptyId: string | null) => void
  retirement: Promise<void> | null
  claimed: boolean
}

export type PendingTerminalTabSpawnRegistration = {
  settle: (ptyId: string | null) => void
  isClaimed: () => boolean
}

export type ClaimedPendingTerminalTabSpawn = {
  retire: (retirePty: (ptyId: string) => Promise<void>) => Promise<void>
}

const pendingSpawnsByTabId = new Map<string, Set<PendingTerminalTabSpawn>>()

export function beginPendingTerminalTabSpawn(tabId: string): PendingTerminalTabSpawnRegistration {
  let resolve!: (ptyId: string | null) => void
  const entry: PendingTerminalTabSpawn = {
    result: new Promise<string | null>((settle) => {
      resolve = settle
    }),
    resolve: (ptyId) => resolve(ptyId),
    retirement: null,
    claimed: false
  }
  const entries = pendingSpawnsByTabId.get(tabId) ?? new Set<PendingTerminalTabSpawn>()
  entries.add(entry)
  pendingSpawnsByTabId.set(tabId, entries)
  let settled = false
  return {
    settle: (ptyId) => {
      if (settled) {
        return
      }
      settled = true
      entry.resolve(ptyId)
      entries.delete(entry)
      if (entries.size === 0 && pendingSpawnsByTabId.get(tabId) === entries) {
        pendingSpawnsByTabId.delete(tabId)
      }
    },
    isClaimed: () => entry.claimed
  }
}

export function claimPendingTerminalTabSpawns(tabId: string): ClaimedPendingTerminalTabSpawn[] {
  const entries = pendingSpawnsByTabId.get(tabId)
  if (!entries) {
    return []
  }
  return [...entries].map((entry) => {
    entry.claimed = true
    return {
      retire: (retirePty) => {
        entry.retirement ??= entry.result.then((ptyId) =>
          ptyId ? retirePty(ptyId) : Promise.resolve()
        )
        return entry.retirement
      }
    }
  })
}

export function waitForPendingTerminalTabRetirement(
  retirement: Promise<void>,
  timeoutMs: number
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('terminal_tab_close_failed')),
      Math.max(1, timeoutMs)
    )
    void retirement.then(
      () => {
        clearTimeout(timer)
        resolve()
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error)
      }
    )
  })
}
