import { isNativeChatSupportedAgent } from './native-chat-agent-support'

/** Where an ownerless host chat shows; `settled` false waits on transcript readability. */
export type OwnerlessChatPlacement = { leafId: string; settled: boolean }

function soleOrActiveLeaf(
  leafIds: readonly string[],
  activeLeafId: string | null | undefined
): string | null {
  const candidate = leafIds.length === 1 ? leafIds[0] : activeLeafId
  return candidate && leafIds.includes(candidate) ? candidate : null
}

/**
 * Where an ownerless host chat shows, as on the paired desktop: on the leaf it already shows on
 * while that leaf exists, else on the active (or sole) leaf only when that leaf can show chat now.
 * Null means every leaf shows terminal.
 */
export function ownerlessChatDisplayLeaf(args: {
  shown: string | null
  leafIds: readonly string[]
  activeLeafId: string | null | undefined
  /** `unknown`: the leaf's agent can show chat once its transcript is known to be readable. */
  canShowChat: (leafId: string) => boolean | 'unknown'
}): OwnerlessChatPlacement | null {
  const { shown, leafIds } = args
  if (shown && leafIds.includes(shown)) {
    return { leafId: shown, settled: true }
  }
  const candidate = soleOrActiveLeaf(leafIds, args.activeLeafId)
  if (!candidate) {
    return null
  }
  const canShow = args.canShowChat(candidate)
  return canShow === false ? null : { leafId: candidate, settled: canShow === true }
}

/**
 * The owner a host stores for a chat that has none: the sole leaf, else the active leaf when its
 * process was launched as a supported agent, else the first such leaf in tree order. Null when no
 * pane is known to run one: a shell pane must never own the composer.
 */
export function pickChatOwnerLeaf(args: {
  /** Tree order. */
  leafIds: readonly string[]
  activeLeafId: string | null | undefined
  leafLaunchAgent: (leafId: string) => string | null | undefined
}): string | null {
  const { leafIds } = args
  if (leafIds.length === 1) {
    return leafIds[0] ?? null
  }
  const runsAgent = (leafId: string): boolean =>
    isNativeChatSupportedAgent(args.leafLaunchAgent(leafId))
  const active = soleOrActiveLeaf(leafIds, args.activeLeafId)
  if (active && runsAgent(active)) {
    return active
  }
  return leafIds.find(runsAgent) ?? null
}
