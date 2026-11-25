// Which marked images are open for editing in any window of this origin. Each open editor has a
// claim of its own: a shared marker under its own key, so closing one editor never ends another's,
// and a Web Lock it holds for as long as it edits. The browser releases a window's locks when that
// window goes away, so a marker whose lock is no longer held was abandoned and is cleared, while a
// live edit counts for as long as it lasts.

const CLAIM_KEY = 'orca.nativeChat.notesEditing.v2'
/** A claim this new may not hold its lock yet: never taken for abandoned. */
const CLAIM_SETTLING_MS = 5_000
/** Without Web Locks nothing tells a live edit from an abandoned one; such a claim counts this long. */
const CLAIM_WITHOUT_LOCKS_MS = 10 * 60_000

const claimPrefix = (scopeKey: string, id: string): string =>
  `${CLAIM_KEY}:${encodeURIComponent(`${scopeKey}\u0000${id}`)}:`
const lockName = (token: string): string => `${CLAIM_KEY}:${token}`
const windowToken = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
let claimSequence = 0

type Claim = { item: string; token: string; at: number }

function claimsOf(scopeKey: string, id: string): Claim[] {
  const storage = globalThis.localStorage
  const prefix = claimPrefix(scopeKey, id)
  const claims: Claim[] = []
  try {
    for (let index = 0; storage && index < storage.length; index += 1) {
      const item = storage.key(index)
      if (item?.startsWith(prefix)) {
        claims.push({
          item,
          token: item.slice(prefix.length),
          at: Number(storage.getItem(item) ?? 0)
        })
      }
    }
  } catch {
    // Unreadable storage: only this window's own edits are known.
  }
  return claims
}

function locks(): LockManager | undefined {
  return globalThis.navigator?.locks
}

/** Clears claims whose editor went away: their lock is no longer held. */
async function reapAbandonedClaims(claims: readonly Claim[]): Promise<void> {
  const manager = locks()
  if (!manager) {
    return
  }
  const { held = [] } = await manager.query()
  const live = new Set(held.map(({ name }) => name))
  for (const claim of claims) {
    if (!live.has(lockName(claim.token)) && claim.at < Date.now() - CLAIM_SETTLING_MS) {
      try {
        globalThis.localStorage?.removeItem(claim.item)
      } catch {
        // Left for the next check.
      }
    }
  }
}

/** Claims this marked image for an editor; the returned function ends exactly this claim. */
export function claimNativeChatNotesEdit(scopeKey: string, id: string): () => void {
  claimSequence += 1
  const token = `${windowToken}-${claimSequence}`
  const item = `${claimPrefix(scopeKey, id)}${token}`
  let ended = false
  let releaseLock = (): void => {}
  void locks()?.request(
    lockName(token),
    () =>
      new Promise<void>((resolve) => {
        // An edit that ended before the lock was granted lets go of it at once.
        releaseLock = resolve
        if (ended) {
          resolve()
        }
      })
  )
  try {
    globalThis.localStorage?.setItem(item, String(Date.now()))
  } catch {
    // Without shared storage the edit is still held back in this window.
  }
  return () => {
    ended = true
    releaseLock()
    try {
      globalThis.localStorage?.removeItem(item)
    } catch {
      // A leftover marker is cleared once its lock is seen released.
    }
  }
}

/** Whether any window has this marked image open for editing. Seeing claims also starts clearing
 *  abandoned ones, so once their windows are gone the next check finds the image free. */
export function nativeChatNotesEditClaimed(scopeKey: string, id: string): boolean {
  const claims = claimsOf(scopeKey, id)
  if (claims.length === 0) {
    return false
  }
  if (!locks()) {
    return claims.some(({ at }) => at > Date.now() - CLAIM_WITHOUT_LOCKS_MS)
  }
  void reapAbandonedClaims(claims)
  return true
}
