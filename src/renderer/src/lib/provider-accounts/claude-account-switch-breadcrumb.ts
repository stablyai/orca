import { recordRendererCrashBreadcrumb } from '@/diagnostics/crash-reporting/crash-breadcrumb-recorder'
import { useAppStore } from '@/store/index'
import { makePaneKey } from '../../../../shared/workspace-layout/stable-pane-id'
import {
  isClaudePaneMidTurn,
  type ClaudeSwitchSessions,
  type InspectedClaudePane
} from '../agent-session/accounts/claude/claude-session-account-move'
import type { ClaudeSwitchCandidatePane } from '../agent-session/accounts/claude/claude-switch-candidate-panes'
import type { ClaudePaneLookups } from '../agent-session/accounts/claude/claude-queued-restart-records'
import type { ClaudeAccountSwitchRunningSessions } from '../../../../shared/agent-accounts/claude/claude-account-switch-settings'

export type ClaudeAccountSwitchRecord = {
  policy: ClaudeAccountSwitchRunningSessions
  madeElsewhere?: true
  fromAccountId: string | null
  toAccountId: string | null
  lookups?: ClaudePaneLookups
  panes?: ClaudeSwitchCandidatePane[]
  inspected?: InspectedClaudePane[]
  found?: ClaudeSwitchSessions | null
  queued?: string[]
}

// Drop whole entries before the generic detail cap can cut a token in half.
const MAX_PANES_DETAIL_LENGTH = 200

type PaneLine = { outcome: 'queued' | 'asked' | 'kept'; reason: string; text: string }

export function recordClaudeAccountSwitchBreadcrumb(
  local: boolean,
  record: ClaudeAccountSwitchRecord,
  result: string
): void {
  const queued = record.queued ?? []
  const panes = (record.panes ?? []).map((pane) => paneLine(pane, record, queued))
  const notMoved = new Map<string, number>()
  for (const pane of panes.filter((line) => line.outcome === 'kept')) {
    notMoved.set(pane.reason, (notMoved.get(pane.reason) ?? 0) + 1)
  }
  recordRendererCrashBreadcrumb('claude_account_switch', {
    setting: record.policy,
    ...(record.madeElsewhere && { madeElsewhere: true }),
    stage: switchStage(local, record, result),
    result,
    from: shortAccountId(record.fromAccountId),
    to: shortAccountId(record.toAccountId),
    seen: panes.length,
    queued: queued.length,
    waitingForTurn:
      record.policy === 'restart-all'
        ? 0
        : queued.filter((ptyId) => waitsForTurn(record, ptyId)).length,
    notMoved: [...notMoved].map(([reason, count]) => `${reason}=${count}`).join(','),
    panes: joinWithinDetailCap(panes.map((pane) => pane.text))
  })
}

function switchStage(local: boolean, record: ClaudeAccountSwitchRecord, result: string): string {
  if (!local) {
    return 'not-local'
  }
  if (record.fromAccountId === record.toAccountId) {
    return 'same-account'
  }
  if (record.found === null) {
    return 'scan-failed'
  }
  if (record.queued) {
    return 'scanned'
  }
  return result === 'handled' ? 'superseded' : 'keep'
}

function paneLine(
  pane: ClaudeSwitchCandidatePane,
  record: ClaudeAccountSwitchRecord,
  queued: string[]
): PaneLine {
  const listed = [...(record.found?.onAccount ?? []), ...(record.found?.elsewhere ?? [])]
  const outcome = queued.includes(pane.ptyId)
    ? 'queued'
    : record.policy === 'ask' && listed.some((session) => session.ptyId === pane.ptyId)
      ? 'asked'
      : 'kept'
  const row = record.inspected?.find((candidate) => candidate.pane.ptyId === pane.ptyId)
  const reason = row ? scannedReason(row, record.found) : unscannedReason(pane, record.lookups)
  const text = `${shortPtyId(pane.ptyId)} ${pane.identifiedBy} ${outcome} ${reason}`
  return { outcome, reason, text }
}

function scannedReason(row: InspectedClaudePane, found: ClaudeSwitchSessions | null | undefined) {
  const cantMove = found?.cantMove.find((session) => session.ptyId === row.pane.ptyId)
  if (cantMove) {
    return cantMove.reason
  }
  if (row.running !== true) {
    return row.running === false ? 'not-running' : 'unchecked'
  }
  return row.group === 'onAccount' ? 'on-account' : 'other-account'
}

function unscannedReason(pane: ClaudeSwitchCandidatePane, lookups?: ClaudePaneLookups): string {
  if (!pane.entry && !pane.session) {
    return lookups?.has(makePaneKey(pane.tabId, pane.leafId)) ? 'not-found' : 'not-looked-up'
  }
  return pane.inLane ? 'on-target' : 'out-of-lane'
}

function waitsForTurn(record: ClaudeAccountSwitchRecord, ptyId: string): boolean {
  const pane = record.panes?.find((candidate) => candidate.ptyId === ptyId)
  return !!pane && isClaudePaneMidTurn(useAppStore.getState(), makePaneKey(pane.tabId, pane.leafId))
}

function joinWithinDetailCap(entries: string[]): string {
  const kept: string[] = []
  for (const entry of entries) {
    if ([...kept, entry].join(', ').length > MAX_PANES_DETAIL_LENGTH) {
      break
    }
    kept.push(entry)
  }
  const dropped = entries.length - kept.length
  return dropped > 0 ? `${kept.join(', ')} (+${dropped} more)` : kept.join(', ')
}

function shortPtyId(ptyId: string): string {
  const at = ptyId.lastIndexOf('@@')
  return at === -1 ? 'unknown' : ptyId.slice(at + 2, at + 10)
}

function shortAccountId(accountId: string | null): string {
  return accountId === null ? 'system' : accountId.slice(0, 8)
}
