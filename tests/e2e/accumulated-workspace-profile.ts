export type AccumulatedWorkspaceFixtureOptions = {
  repositories?: number
  worktrees?: number
  terminalTabs?: number
  unifiedTabs?: number
  panesPerTab?: number
  sleepingRecords?: number
  liveStatuses?: number
  lineageEvery?: number
  statusHistoryEntries?: number
}

export type NormalizedAccumulatedWorkspaceFixtureOptions =
  Required<AccumulatedWorkspaceFixtureOptions>

const defaults: NormalizedAccumulatedWorkspaceFixtureOptions = {
  repositories: 27,
  worktrees: 870,
  terminalTabs: 1_410,
  unifiedTabs: 2_000,
  panesPerTab: 1,
  sleepingRecords: 857,
  liveStatuses: 177,
  lineageEvery: 8,
  statusHistoryEntries: 3
}

function positiveInteger(value: number, fallback: number): number {
  return Number.isInteger(value) && value > 0 ? value : fallback
}

export function normalizeAccumulatedWorkspaceFixtureOptions(
  options: AccumulatedWorkspaceFixtureOptions
): NormalizedAccumulatedWorkspaceFixtureOptions {
  const merged = { ...defaults, ...options }
  const worktrees = positiveInteger(merged.worktrees, defaults.worktrees)
  const repositories = Math.min(
    worktrees,
    positiveInteger(merged.repositories, defaults.repositories)
  )
  const terminalTabs = Math.max(
    worktrees,
    positiveInteger(merged.terminalTabs, defaults.terminalTabs)
  )
  const panesPerTab = positiveInteger(merged.panesPerTab, defaults.panesPerTab)
  const paneCount = terminalTabs * panesPerTab
  const sleepingRecords = Math.min(paneCount, Math.max(0, Math.floor(merged.sleepingRecords)))
  return {
    repositories,
    worktrees,
    terminalTabs,
    unifiedTabs: Math.max(terminalTabs, positiveInteger(merged.unifiedTabs, defaults.unifiedTabs)),
    panesPerTab,
    sleepingRecords,
    liveStatuses: Math.min(
      paneCount - sleepingRecords,
      Math.max(0, Math.floor(merged.liveStatuses))
    ),
    lineageEvery: positiveInteger(merged.lineageEvery, defaults.lineageEvery),
    statusHistoryEntries: positiveInteger(
      merged.statusHistoryEntries,
      defaults.statusHistoryEntries
    )
  }
}
