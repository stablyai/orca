import type { AgentJournalRenderItem } from './agent-session/journal/agent-session-journal-types'
import { agentJournalItemRowOrigin } from './agent-session/journal/agent-session-journal-position'
import { agentJournalLinkageFields } from './agent-session/journal/agent-session-journal-producer'
import type { NativeChatMessage } from './native-chat/native-chat-types'
import { projectStructuredAgentStartItem } from './native-chat/transcript/messages/structured-agent-start-projection'
import { readAutomationRunMessage } from './automations/automation-run-message'
import { readAgentSessionRefusalReference } from './agent-session/failures/agent-session-wire-refusals'
import { agentSessionRefusalCauseParts } from './agent-session/failures/agent-session-refusal-notice'
import { agentSessionRefusalFailure } from './agent-session/failures/agent-session-write-failure'

/** A bot automation run no chat took, drawn by the desktop and the phone; null for anything else. */
export function projectAutomationRunNotStartedItem(
  item: AgentJournalRenderItem
): NativeChatMessage | null {
  if (item.body.kind !== 'automation-run-not-started') {
    return null
  }
  const { kind: _kind, refusal: savedRefusal, ...notStarted } = item.body
  const run = readAutomationRunMessage(notStarted.run)
  // Kept only when this build can say its cause; otherwise the host's own sentence says more.
  const read = readAgentSessionRefusalReference(savedRefusal)
  const refusal =
    read && agentSessionRefusalCauseParts(agentSessionRefusalFailure(read)).length > 0
      ? read
      : undefined
  return run
    ? {
        ...agentJournalItemRowOrigin(item),
        ...agentJournalLinkageFields(item),
        role: 'system',
        blocks: [],
        automationRunNotStarted: { ...notStarted, run, ...(refusal ? { refusal } : {}) }
      }
    : null
}

/** A saved automation or a wait's ending, drawn by the desktop and the phone; null for anything else. */
export function projectAutomationSavedItem(item: AgentJournalRenderItem): NativeChatMessage | null {
  if (item.body.kind === 'wait-ended') {
    const { kind: _kind, ...waitEnded } = item.body
    return {
      ...agentJournalItemRowOrigin(item),
      ...agentJournalLinkageFields(item),
      role: 'system',
      blocks: [],
      waitEnded
    }
  }
  if (item.body.kind !== 'automation-saved') {
    return null
  }
  const { kind: _kind, ...saved } = item.body
  return {
    ...agentJournalItemRowOrigin(item),
    ...agentJournalLinkageFields(item),
    role: 'system',
    blocks: [],
    automationSaved: saved
  }
}

/** An item note's quiet line, drawn by the desktop and the phone; null for anything else. */
export function projectBotItemNoteItem(item: AgentJournalRenderItem): NativeChatMessage | null {
  if (item.body.kind !== 'bot-item-note') {
    return null
  }
  const { kind: _kind, ...botItemNote } = item.body
  return {
    ...agentJournalItemRowOrigin(item),
    ...agentJournalLinkageFields(item),
    role: 'system',
    blocks: [],
    botItemNote
  }
}

/** A bot backup-model switch notice, drawn by desktop and mobile; null for anything else. */
export function projectBotBackupModelSwitchItem(
  item: AgentJournalRenderItem
): NativeChatMessage | null {
  if (item.body.kind !== 'bot-backup-model-switch') {
    return null
  }
  const { kind: _kind, ...botBackupModelSwitch } = item.body
  return {
    ...agentJournalItemRowOrigin(item),
    ...agentJournalLinkageFields(item),
    role: 'system',
    blocks: [],
    botBackupModelSwitch
  }
}

/** Orca's transcript cards (a started worker, a saved automation or ended wait, an added tool, a run
 *  that couldn't start); every other row as usual. */
export function projectStructuredOrcaCardItem(
  item: AgentJournalRenderItem
): NativeChatMessage | null {
  if (item.body.kind === 'tool-added') {
    const { kind: _kind, ...toolAdded } = item.body
    return {
      ...agentJournalItemRowOrigin(item),
      ...agentJournalLinkageFields(item),
      role: 'system',
      blocks: [],
      toolAdded
    }
  }
  if (item.body.kind === 'automation-run-not-started') {
    return projectAutomationRunNotStartedItem(item)
  }
  if (item.body.kind === 'bot-item-note') {
    return projectBotItemNoteItem(item)
  }
  if (item.body.kind === 'bot-backup-model-switch') {
    return projectBotBackupModelSwitchItem(item)
  }
  return projectAutomationSavedItem(item) ?? projectStructuredAgentStartItem(item)
}
