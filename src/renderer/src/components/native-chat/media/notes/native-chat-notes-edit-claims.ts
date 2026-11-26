// Which marked images are open for editing in any window of this origin. Each open editor has a
// claim of its own, so closing one editor never ends another's, and a Web Lock it holds for as long
// as it edits. The claim is published twice: as a shared marker under its own key, and announced to
// the other windows on a channel, which still tells them when storage refuses the marker. The
// browser releases a window's locks when that window goes away, so a claim whose lock is neither
// held nor being acquired was abandoned and is cleared, while a live edit counts for as long as it
// lasts.

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

type Claim = { item: string | null; token: string; at: number }
type Announced = { scopeKey: string; id: string; at: number }

const CHANNEL_NAME = 'orca-native-chat-notes-edit'
// This window's live claims, and those other windows announced.
const ownClaims = new Map<string, Announced>()
const announcedClaims = new Map<string, Announced>()

function isAnnounced(value: unknown): value is Announced & { token: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'token' in value &&
    typeof value.token === 'string' &&
    'scopeKey' in value &&
    typeof value.scopeKey === 'string' &&
    'id' in value &&
    typeof value.id === 'string' &&
    'at' in value &&
    typeof value.at === 'number'
  )
}

function receive(data: unknown): void {
  if (typeof data !== 'object' || data === null || !('type' in data)) {
    return
  }
  if (data.type === 'claim' && isAnnounced(data)) {
    announcedClaims.set(data.token, { scopeKey: data.scopeKey, id: data.id, at: data.at })
  } else if (data.type === 'release' && 'token' in data && typeof data.token === 'string') {
    announcedClaims.delete(data.token)
  } else if (data.type === 'query') {
    // A window that just opened asks who is editing.
    for (const [token, claim] of ownClaims) {
      channel?.postMessage({ type: 'claim', token, ...claim })
    }
  }
}

// Listening from the start, so a window knows other windows' edits before its first Send.
const channel: BroadcastChannel | null =
  typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(CHANNEL_NAME)
if (channel) {
  channel.onmessage = (event) => receive(event.data)
  // Why: Node's channel (unit tests) would otherwise keep the process alive.
  if ('unref' in channel && typeof channel.unref === 'function') {
    channel.unref()
  }
  channel.postMessage({ type: 'query' })
}

// A window that goes away (closed or reloaded) with an editor still open lets go of its claims, so
// without Web Locks no other window waits on them for the full ten minutes; with Web Locks this
// only makes them go sooner. A window that crashes can't, and is cleared by its lock or its time.
globalThis.addEventListener?.('pagehide', () => {
  for (const [token, claim] of ownClaims) {
    channel?.postMessage({ type: 'release', token })
    try {
      globalThis.localStorage?.removeItem(`${claimPrefix(claim.scopeKey, claim.id)}${token}`)
    } catch {
      // Left for its lock or its time limit.
    }
  }
  ownClaims.clear()
})

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
  for (const [token, claim] of announcedClaims) {
    if (claim.scopeKey === scopeKey && claim.id === id && !claims.some((c) => c.token === token)) {
      claims.push({ item: null, token, at: claim.at })
    }
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
  // A lock still being acquired is as live as a held one.
  const { held = [], pending = [] } = await manager.query()
  const live = new Set([...held, ...pending].map(({ name }) => name))
  for (const claim of claims) {
    if (!live.has(lockName(claim.token)) && claim.at < Date.now() - CLAIM_SETTLING_MS) {
      announcedClaims.delete(claim.token)
      try {
        if (claim.item) {
          globalThis.localStorage?.removeItem(claim.item)
        }
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
  const at = Date.now()
  ownClaims.set(token, { scopeKey, id, at })
  channel?.postMessage({ type: 'claim', token, scopeKey, id, at })
  try {
    globalThis.localStorage?.setItem(item, String(at))
  } catch {
    // Refused: the announcement above still tells the other windows.
  }
  return () => {
    ended = true
    ownClaims.delete(token)
    channel?.postMessage({ type: 'release', token })
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

/** Whether a window other than this one has this marked image open for editing. */
export function nativeChatNotesEditClaimedElsewhere(scopeKey: string, id: string): boolean {
  const claims = claimsOf(scopeKey, id).filter(({ token }) => !token.startsWith(`${windowToken}-`))
  if (claims.length === 0) {
    return false
  }
  if (!locks()) {
    return claims.some(({ at }) => at > Date.now() - CLAIM_WITHOUT_LOCKS_MS)
  }
  void reapAbandonedClaims(claims)
  return true
}
