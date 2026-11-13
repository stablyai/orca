import { awaitsCodexRestartAnswer } from '@/components/codex-restart-notice-state'
import type { CodexRestartNotice } from '@/store/terminals/terminal-contracts'

export type CodexRestartStatusSummaryInput = {
  ptyIdsByTabId: Record<string, string[]>
  codexRestartNoticeByPtyId: Record<string, CodexRestartNotice | undefined>
}

export type CodexRestartStatusSummary = {
  stalePtyIds: string[]
  /** Zero unless a stale session is still bound to a tab, so orphaned notices never prompt. */
  staleSessionCount: number
}

const EMPTY_CODEX_RESTART_STATUS_SUMMARY: CodexRestartStatusSummary = {
  stalePtyIds: [],
  staleSessionCount: 0
}

export function summarizeCodexRestartStatus({
  ptyIdsByTabId,
  codexRestartNoticeByPtyId
}: CodexRestartStatusSummaryInput): CodexRestartStatusSummary {
  // Exclude scheduled restarts and dismissed notices; dismissed records retain launch-account memory only.
  const stalePtyIds = Object.entries(codexRestartNoticeByPtyId)
    .filter(([, notice]) => awaitsCodexRestartAnswer(notice))
    .map(([ptyId]) => ptyId)
  if (stalePtyIds.length === 0) {
    return EMPTY_CODEX_RESTART_STATUS_SUMMARY
  }

  const stalePtyIdSet = new Set(stalePtyIds)
  const boundToTab = Object.values(ptyIdsByTabId).some((ptyIds) =>
    ptyIds.some((ptyId) => stalePtyIdSet.has(ptyId))
  )
  return boundToTab
    ? { stalePtyIds, staleSessionCount: stalePtyIds.length }
    : EMPTY_CODEX_RESTART_STATUS_SUMMARY
}

let memoNotices: CodexRestartStatusSummaryInput['codexRestartNoticeByPtyId'] | null = null
let memoBindings: CodexRestartStatusSummaryInput['ptyIdsByTabId'] | null = null
let memoCount = 0

/** Store selector for always-mounted surfaces: unrelated writes cost two reference checks and allocate nothing. */
export function selectCodexStaleSessionCount(state: CodexRestartStatusSummaryInput): number {
  if (state.codexRestartNoticeByPtyId !== memoNotices || state.ptyIdsByTabId !== memoBindings) {
    memoNotices = state.codexRestartNoticeByPtyId
    memoBindings = state.ptyIdsByTabId
    memoCount = summarizeCodexRestartStatus(state).staleSessionCount
  }
  return memoCount
}
