import { awaitsCodexRestartAnswer } from '@/components/codex-restart-notice-state'
import type { CodexRestartNotice } from '@/store/slices/terminals'

type TabLookup = Record<string, { id: string }[]>

export type CodexRestartStatusSummaryInput = {
  tabsByWorktree: TabLookup
  ptyIdsByTabId: Record<string, string[]>
  codexRestartNoticeByPtyId: Record<string, CodexRestartNotice | undefined>
}

export type CodexRestartStatusSummary = {
  stalePtyIds: string[]
  staleSessionCount: number
  staleTabCount: number
  staleWorktreeCount: number
}

const EMPTY_CODEX_RESTART_STATUS_SUMMARY: CodexRestartStatusSummary = {
  stalePtyIds: [],
  staleSessionCount: 0,
  staleTabCount: 0,
  staleWorktreeCount: 0
}

export function summarizeCodexRestartStatus({
  tabsByWorktree,
  ptyIdsByTabId,
  codexRestartNoticeByPtyId
}: CodexRestartStatusSummaryInput): CodexRestartStatusSummary {
  // Why: a requested restart is already scheduled for its pane's next mount, so
  // re-offering it here would leave a prompt whose button does nothing; a
  // dismissed notice survives only as launch-account memory.
  const stalePtyIds = Object.entries(codexRestartNoticeByPtyId)
    .filter(([, notice]) => awaitsCodexRestartAnswer(notice))
    .map(([ptyId]) => ptyId)
  if (stalePtyIds.length === 0) {
    return EMPTY_CODEX_RESTART_STATUS_SUMMARY
  }

  const stalePtyIdSet = new Set(stalePtyIds)
  const staleTabIds = new Set<string>()
  for (const [tabId, ptyIds] of Object.entries(ptyIdsByTabId)) {
    if (ptyIds.some((ptyId) => stalePtyIdSet.has(ptyId))) {
      staleTabIds.add(tabId)
    }
  }

  const staleWorktreeIds = new Set<string>()
  for (const [worktreeId, tabs] of Object.entries(tabsByWorktree)) {
    if (tabs.some((tab) => staleTabIds.has(tab.id))) {
      staleWorktreeIds.add(worktreeId)
    }
  }

  return {
    stalePtyIds,
    staleSessionCount: stalePtyIds.length,
    staleTabCount: staleTabIds.size,
    staleWorktreeCount: staleWorktreeIds.size
  }
}
