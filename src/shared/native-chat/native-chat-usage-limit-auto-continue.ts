// What a usage-limit row says about the host's automatic continue; only the host decides sends.

import type { AgentSessionStatusSummary } from '../agent-session/agent-session-wire'
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

/** The host's published state for exactly this cut; undefined when it speaks of another one. */
export function usageLimitContinueStateForCut(
  published: PublishedUsageLimitContinue,
  cut: CutKey
): NativeChatUsageLimitContinueState | undefined {
  return publishedForCut(published, cut)?.state
}

/** The reset Orca waits for before continuing this cut: a later one the account still shows spent. */
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
