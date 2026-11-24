// What a usage-limit row says about the host's automatic continue; only the host decides sends.

import type { AgentSessionStatusSummary } from '../../../agent-session/agent-session-wire'
import type { NativeChatUsageLimitCut } from './native-chat-usage-limit-cut'

type PublishedUsageLimitContinue = AgentSessionStatusSummary['usageLimitContinue']
export type NativeChatUsageLimitContinueState = NonNullable<PublishedUsageLimitContinue>['state']
export type NativeChatUsageLimitAutoContinueKind = 'off' | 'scheduled' | 'cancelled'

type CutKey = Pick<NativeChatUsageLimitCut, 'turnItemId' | 'resetsAt'> | null | undefined

const publishedForCut = (published: PublishedUsageLimitContinue, cut: CutKey) =>
  cut?.resetsAt !== undefined &&
  published !== undefined &&
  published.turnItemId === cut.turnItemId &&
  published.resetsAt === cut.resetsAt
    ? published
    : undefined

/** The reset the host keys this cut by: its own, or, when it has none, the time the chat moved to
 *  another account, which the host publishes for the cut's turn. */
export function usageLimitContinueResetForCut(
  published: PublishedUsageLimitContinue,
  cut: CutKey
): number | undefined {
  return (
    cut?.resetsAt ??
    (cut && published?.turnItemId === cut.turnItemId ? published.resetsAt : undefined)
  )
}

/** The host's published state for exactly this cut; undefined when it speaks of another one. */
export function usageLimitContinueStateForCut(
  published: PublishedUsageLimitContinue,
  cut: CutKey
): NativeChatUsageLimitContinueState | undefined {
  return publishedForCut(published, cut)?.state
}

/** When Orca continues this cut: a later reset the account still shows spent, or earlier after a switch. */
export function usageLimitContinueAtForCut(
  published: PublishedUsageLimitContinue,
  cut: CutKey
): number | undefined {
  return publishedForCut(published, cut)?.continueAt ?? cut?.resetsAt
}

/** Null hides the line. "Off" only points at this machine's own setting, so other hosts hide it. */
export function nativeChatUsageLimitAutoContinueKind(
  state: NativeChatUsageLimitContinueState | undefined,
  { schedulable, localHost }: { schedulable: boolean; localHost: boolean }
): NativeChatUsageLimitAutoContinueKind | null {
  if (state === undefined || !schedulable) {
    return null
  }
  if (state === 'off') {
    return localHost ? 'off' : null
  }
  return state === 'scheduled' ? 'scheduled' : 'cancelled'
}

/** Settled facts that leave this machine no say in the chat's automatic continue: the host lacks
 *  the feature, or another machine's own setting is off. Loading or unpublished state is not one. */
export function nativeChatUsageLimitAutoContinueUnavailable(
  capability: 'supported' | 'unsupported' | 'unknown',
  state: NativeChatUsageLimitContinueState | undefined,
  { localHost }: { localHost: boolean }
): boolean {
  return (
    capability === 'unsupported' || (capability === 'supported' && state === 'off' && !localHost)
  )
}
