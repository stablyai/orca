// Which draft a move left behind, and where it went, saved when the move starts so a later run
// knows it. Only that source may ever retire as a leftover copy of that destination, never the other
// way round: saved times can't tell the two apart (a clock step can swap them), and a fork moves one
// chat's draft into another chat's, so neither can scope names. Refused, nothing retires later; at
// most a copy is left behind.

const KEY = 'orca.nativeChat.movedDraftSource.v1'
const itemOf = (sourceScope: string): string => `${KEY}:${encodeURIComponent(sourceScope)}`

/** A move from `sourceScope` into `destinationScope` begins. */
export function recordMovedNativeChatDraftSource(
  sourceScope: string,
  destinationScope: string
): void {
  try {
    globalThis.localStorage?.setItem(itemOf(sourceScope), destinationScope)
  } catch {
    // Refused: the source is never taken for a leftover, so it can only stay.
  }
}

/** Where the draft saved under `sourceScope` was moved, if a move left it behind. */
export function movedNativeChatDraftDestination(sourceScope: string): string | null {
  try {
    return globalThis.localStorage?.getItem(itemOf(sourceScope)) ?? null
  } catch {
    return null
  }
}

/** The source is gone, or holds a draft of its own again: it is no longer a move's leftover. */
export function forgetMovedNativeChatDraftSource(sourceScope: string): void {
  try {
    globalThis.localStorage?.removeItem(itemOf(sourceScope))
  } catch {
    // Left over, it names a draft that is gone, or one whose words now keep it.
  }
}

/** Every saved move: the source each left behind, and where it went. */
export function movedNativeChatDraftSources(): [source: string, destination: string][] {
  const storage = globalThis.localStorage
  const prefix = `${KEY}:`
  const moves: [string, string][] = []
  try {
    for (let index = 0; storage && index < storage.length; index += 1) {
      const item = storage.key(index)
      const destination = item?.startsWith(prefix) ? storage.getItem(item) : null
      if (item && destination !== null) {
        moves.push([decodeURIComponent(item.slice(prefix.length)), destination])
      }
    }
  } catch {
    // Unreadable storage: tried again next run.
  }
  return moves
}

/** Once per run: forgets the moves whose source no longer keeps anything (`keeps`): no saved draft,
 *  and no notes held for its chat. */
export function pruneMovedNativeChatDraftSources(keeps: (scope: string) => boolean): void {
  for (const [source] of movedNativeChatDraftSources()) {
    if (!keeps(source)) {
      forgetMovedNativeChatDraftSource(source)
    }
  }
}
