// A setup failure (sign-in, install, model) is resolved once a later turn succeeds; its setup action then goes stale.

import { isRootAgentJournalItem } from '../../../agent-session/journal/agent-session-journal-producer'
import {
  agentJournalItemPosition,
  compareAgentJournalPositions
} from '../../../agent-session/journal/agent-session-journal-position'
import type {
  AgentJournalPosition,
  AgentJournalRenderItem
} from '../../../agent-session/journal/agent-session-journal-types'
import {
  readAgentJournalTurn,
  readAgentJournalTurnOutcome
} from '../../../agent-session/lifecycle/records/agent-session-turn-record'

/** Failure kinds a host sign-in fixes. */
export const NATIVE_CHAT_SIGN_IN_FAILURE_KINDS: ReadonlySet<string> = new Set([
  'notSignedIn',
  'claudeAccountFolderMissing'
])

const SETUP_FAILURE_KINDS: ReadonlySet<string> = new Set([
  ...NATIVE_CHAT_SIGN_IN_FAILURE_KINDS,
  'modelNotSelected',
  'cliMissing'
])

/** Failure kinds a host setup step can fix. */
export function isNativeChatSetupFailureKind(kind: string | undefined): boolean {
  return kind !== undefined && SETUP_FAILURE_KINDS.has(kind)
}

/** The chat's latest root turn that succeeded; the same row across stream frames while it stays latest. */
export function latestNativeChatSucceededTurn(
  items: readonly AgentJournalRenderItem[]
): AgentJournalRenderItem | null {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]!
    if (
      isRootAgentJournalItem(item) &&
      readAgentJournalTurnOutcome(readAgentJournalTurn(item.body)) === 'success'
    ) {
      return item
    }
  }
  return null
}

/** Whether a setup failure row precedes a turn that succeeded, so desktop and phone mute it alike. */
export function isResolvedNativeChatSetupFailure(
  kind: string | undefined,
  position: AgentJournalPosition | undefined,
  succeededTurn: Pick<AgentJournalRenderItem, 'sequence' | 'sequenceIndex'> | null | undefined
): boolean {
  if (!position || !succeededTurn || !isNativeChatSetupFailureKind(kind)) {
    return false
  }
  return compareAgentJournalPositions(position, agentJournalItemPosition(succeededTurn)) < 0
}
