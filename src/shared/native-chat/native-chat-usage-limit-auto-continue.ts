// What a usage-limit row says about the host's automatic continue; only the host decides sends.

import type { AgentSessionStatusSummary } from '../agent-session/agent-session-wire'
import type { NativeChatUsageLimitCut } from './native-chat-usage-limit-cut'

type PublishedUsageLimitContinue = AgentSessionStatusSummary['usageLimitContinue']
export type NativeChatUsageLimitContinueState = NonNullable<PublishedUsageLimitContinue>['state']
export type NativeChatUsageLimitAutoContinueKind = 'off' | 'scheduled' | 'cancelled'

/** The host's published state for exactly this cut; undefined when it speaks of another one. */
export function usageLimitContinueStateForCut(
  published: PublishedUsageLimitContinue,
  cut: Pick<NativeChatUsageLimitCut, 'turnItemId' | 'resetsAt'> | null | undefined
): NativeChatUsageLimitContinueState | undefined {
  return cut?.resetsAt !== undefined &&
    published !== undefined &&
    published.turnItemId === cut.turnItemId &&
    published.resetsAt === cut.resetsAt
    ? published.state
    : undefined
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
