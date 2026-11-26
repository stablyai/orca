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

/** Once per run: forgets the moves whose source draft is no longer saved. */
export function pruneMovedNativeChatDraftSources(hasDraft: (scope: string) => boolean): void {
  const storage = globalThis.localStorage
  const prefix = `${KEY}:`
  try {
    const sources: string[] = []
    for (let index = 0; storage && index < storage.length; index += 1) {
      const item = storage.key(index)
      if (item?.startsWith(prefix)) {
        sources.push(decodeURIComponent(item.slice(prefix.length)))
      }
    }
    for (const source of sources.filter((scope) => !hasDraft(scope))) {
      forgetMovedNativeChatDraftSource(source)
    }
  } catch {
    // Unreadable storage: tried again next run.
  }
}
