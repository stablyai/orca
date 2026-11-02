const owners = new Map<string, number>()

function closeKey(worktreeId: string, tabId: string): string {
  return JSON.stringify([worktreeId, tabId])
}

export function isLocalSessionTabCloseOwned(worktreeId: string, tabId: string): boolean {
  return owners.has(closeKey(worktreeId, tabId))
}

/** The initiating command owns UI removal; its local host relay only acknowledges the handoff. */
export async function withLocalSessionTabCloseOwner<T>(
  worktreeId: string,
  tabId: string,
  close: () => Promise<T>
): Promise<T> {
  const key = closeKey(worktreeId, tabId)
  owners.set(key, (owners.get(key) ?? 0) + 1)
  try {
    return await close()
  } finally {
    const remaining = (owners.get(key) ?? 1) - 1
    if (remaining === 0) {
      owners.delete(key)
    } else {
      owners.set(key, remaining)
    }
  }
}
