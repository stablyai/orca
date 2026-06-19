type TabLookup = Record<string, { id: string }[]>

export type CodexRestartStatusSummaryInput = {
  tabsByWorktree: TabLookup
  ptyIdsByTabId: Record<string, string[]>
  codexRestartNoticeByPtyId: Record<string, unknown>
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
  const stalePtyIds = Object.keys(codexRestartNoticeByPtyId)
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
