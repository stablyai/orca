type TabLookup = Record<string, { id: string }[]>

export type CodexRestartStatusSummaryInput = {
  tabsByWorktree: TabLookup
  ptyIdsByTabId: Record<string, string[]>
  codexRestartNoticeByPtyId: Record<string, unknown>
}

export type AccountRestartStatusSummaryInput = {
  tabsByWorktree: TabLookup
  ptyIdsByTabId: Record<string, string[]>
  restartNoticeByPtyId: Record<string, unknown>
}

export type AccountRestartStatusSummary = {
  stalePtyIds: string[]
  staleSessionCount: number
  staleTabCount: number
  staleWorktreeCount: number
}

export type CodexRestartStatusSummary = AccountRestartStatusSummary

const EMPTY_ACCOUNT_RESTART_STATUS_SUMMARY: AccountRestartStatusSummary = {
  stalePtyIds: [],
  staleSessionCount: 0,
  staleTabCount: 0,
  staleWorktreeCount: 0
}

export function summarizeAccountRestartStatus({
  tabsByWorktree,
  ptyIdsByTabId,
  restartNoticeByPtyId
}: AccountRestartStatusSummaryInput): AccountRestartStatusSummary {
  const stalePtyIds = Object.keys(restartNoticeByPtyId)
  if (stalePtyIds.length === 0) {
    return EMPTY_ACCOUNT_RESTART_STATUS_SUMMARY
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

export function summarizeCodexRestartStatus({
  tabsByWorktree,
  ptyIdsByTabId,
  codexRestartNoticeByPtyId
}: CodexRestartStatusSummaryInput): CodexRestartStatusSummary {
  return summarizeAccountRestartStatus({
    tabsByWorktree,
    ptyIdsByTabId,
    restartNoticeByPtyId: codexRestartNoticeByPtyId
  })
}
