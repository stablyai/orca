import {
  readWholeAgentSessionFailureFact,
  type AgentSessionFailureFact
} from './agent-session-failure'
import type { AgentJournalRenderItem } from '../journal/agent-session-journal-types'
import { isStructuredAgentSessionStartFailureRow } from './structured-agent-session-start-failure-row-key'
import { isRootAgentJournalItem } from '../journal/agent-session-journal-producer'
import {
  readAgentJournalTurn,
  readAgentJournalTurnOutcome
} from '../lifecycle/records/agent-session-turn-record'
import { agentTurnVerdict } from '../../agent-status/lifecycle/agent-turn-outcome'
import { isStructuredAgentSessionCommandEntry } from '../requests/structured-agent-session-command-entry'

/** Loaded startup causes and authentication explanations already visible in the transcript. */
export function agentSessionVisibleFailureFacts(
  items: readonly AgentJournalRenderItem[]
): AgentSessionFailureFact[] {
  const facts: AgentSessionFailureFact[] = []
  for (const item of items) {
    if (item.body.kind === 'status') {
      const fact = readWholeAgentSessionFailureFact(item.body.failure)
      if (
        fact &&
        (isStructuredAgentSessionStartFailureRow(item.itemId) || fact.kind === 'notSignedIn')
      ) {
        facts.push(fact)
      }
    }
  }
  return facts
}

const SETUP_FAILURE_KINDS: ReadonlySet<string> = new Set([
  'notSignedIn',
  'claudeAccountFolderMissing',
  'cliMissing',
  'modelNotSelected'
])

/** Failures a host setup step fixes: sign-in, install, or picking a model. */
export function isAgentSessionSetupFailureKind(kind: string | undefined): boolean {
  return kind !== undefined && SETUP_FAILURE_KINDS.has(kind)
}

/** Setup failure rows, and sent messages when asked, after the latest successful turn, which resolved every one before it. */
export function agentSessionUnresolvedFailureRows(
  items: readonly AgentJournalRenderItem[],
  options: { sentMessages: boolean }
): string[] {
  const rows: string[] = []
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]!
    const { body } = item
    const turn = readAgentJournalTurn(body)
    if (
      turn &&
      isRootAgentJournalItem(item) &&
      agentTurnVerdict({ state: turn.state, outcome: readAgentJournalTurnOutcome(turn) }) ===
        'success' &&
      !openedByCommand(items, index, turn.userItemId)
    ) {
      break
    }
    if (
      (body.kind === 'status' &&
        isAgentSessionSetupFailureKind(readWholeAgentSessionFailureFact(body.failure)?.kind)) ||
      (options.sentMessages && body.kind === 'message' && body.role === 'user')
    ) {
      rows.push(item.itemId)
    }
  }
  return rows
}

/** Whether the turn at `index` ran a conversation command such as `/compact`, which proves no setup. */
function openedByCommand(
  items: readonly AgentJournalRenderItem[],
  index: number,
  userItemId: string | undefined
): boolean {
  if (userItemId === undefined) {
    return false
  }
  // Its opener sits after the previous turn's row, so the look back stops there.
  for (let back = index - 1; back >= 0; back -= 1) {
    const item = items[back]!
    if (item.itemId === userItemId) {
      return isStructuredAgentSessionCommandEntry(item.body)
    }
    if (item.body.kind === 'turn' && isRootAgentJournalItem(item)) {
      return false
    }
  }
  return false
}

function sameInstallation(
  a: { installedVersion: string | null; minimumVersion: string } | undefined,
  b: { installedVersion: string | null; minimumVersion: string } | undefined
): boolean {
  return a?.installedVersion === b?.installedVersion && a?.minimumVersion === b?.minimumVersion
}

/** Whether two facts are one failure: a start's row and the messages it rejected share one. */
export function sameAgentSessionFailureFact(
  a: AgentSessionFailureFact,
  b: AgentSessionFailureFact
): boolean {
  return (
    a.kind === b.kind &&
    a.account === b.account &&
    a.detail?.text === b.detail?.text &&
    a.detail?.audience === b.detail?.audience &&
    a.refusal?.code === b.refusal?.code &&
    a.refusal?.details?.reason === b.refusal?.details?.reason &&
    (a.refusal?.code !== 'agent_session_operation_invalid' ||
      b.refusal?.code !== 'agent_session_operation_invalid' ||
      (sameInstallation(
        a.refusal.details?.agentInstallation,
        b.refusal.details?.agentInstallation
      ) &&
        sameInstallation(
          a.refusal.details?.codexInstallation,
          b.refusal.details?.codexInstallation
        ))) &&
    a.attachment?.reason === b.attachment?.reason &&
    a.attachment?.limit === b.attachment?.limit &&
    a.retry?.error === b.retry?.error &&
    a.retry?.status === b.retry?.status
  )
}

/** Whether a loaded row already states this failure, comparing facts rather than wording. */
export function agentSessionFailureStatedByRow(
  failure: unknown,
  statedFailures: readonly AgentSessionFailureFact[]
): boolean {
  const fact = readWholeAgentSessionFailureFact(failure)
  return (
    fact !== undefined && statedFailures.some((stated) => sameAgentSessionFailureFact(stated, fact))
  )
}
