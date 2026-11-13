import { AgentStatusProjectionState } from './agent-status-projection-state'

export function captureProjectionState(
  data: AgentStatusProjectionState
): AgentStatusProjectionState {
  const captured = new AgentStatusProjectionState()
  Object.assign(captured.tabTypes, data.tabTypes)
  Object.assign(captured.unsafeTabs, data.unsafeTabs)
  captured.tabProjection = {
    tabAgentTypesByTabId: captured.tabTypes,
    nativeChatTabWideFallbackUnsafeTabsById: captured.unsafeTabs,
    revision: data.tabProjection.revision
  }
  captured.display = data.display.capture()
  captured.activeDashboardOwners = new Set(data.activeDashboardOwners)
  captured.dashboardTotals = data.dashboardTotals
  captured.inputs = data.inputs
  for (const [key, tab] of data.represented) {
    captured.represented.set(key, tab)
  }
  captured.nextRank = data.nextRank
  captured.nextRowRevision = data.nextRowRevision
  captured.freshEvidence = data.freshEvidence
  captured.deadCandidates = data.deadCandidates.capture()
  captured.freshCandidates = data.freshCandidates.capture()
  captured.candidateExpiries = data.candidateExpiries.capture()
  for (const [key, value] of data.orphanOwners) {
    captured.orphanOwners.set(key, value)
  }
  for (const [key, value] of data.handleByKey) {
    captured.handleByKey.set(key, value)
  }
  for (const [key, value] of data.countedRows) {
    captured.countedRows.set(key, value)
  }
  for (const [key, value] of data.countsByWorktree) {
    captured.countsByWorktree.set(key, value)
  }
  for (const [key, value] of data.mobileOwners) {
    captured.mobileOwners.set(key, value)
  }
  for (const [key, value] of data.mobileOutputs) {
    captured.mobileOutputs.set(key, value)
  }
  for (const [key, value] of data.tabs) {
    captured.tabs.set(key, value)
  }
  for (const [key, value] of data.tabWorktrees) {
    captured.tabWorktrees.set(key, value)
  }
  for (const [key, value] of data.rows) {
    captured.rows.set(key, value)
  }
  for (const [key, value] of data.rowsForSource) {
    captured.rowsForSource.set(key, value)
  }
  for (const [key, value] of data.ownerForSource) {
    captured.ownerForSource.set(key, value)
  }
  for (const [key, value] of data.fallbackRows) {
    captured.fallbackRows.set(key, value)
  }
  for (const [key, value] of data.unsupportedRows) {
    captured.unsupportedRows.set(key, value)
  }
  for (const [key, value] of data.contributions) {
    captured.contributions.set(key, value)
  }
  for (const [key, value] of data.suppressed) {
    captured.suppressed.set(key, value)
  }
  for (const [key, value] of data.suppressionsBySource) {
    captured.suppressionsBySource.set(key, value)
  }
  for (const [key, value] of data.ranks) {
    captured.ranks.set(key, value)
  }
  for (const [key, value] of data.candidates) {
    captured.candidates.set(key, value)
  }
  for (const [key, value] of data.icons) {
    captured.icons.set(key, value)
  }
  for (const [key, value] of data.fullRows) {
    captured.fullRows.set(key, value)
  }
  for (const field of [
    'orphansByOwner',
    'acceptedByTab',
    'fallbackByTab',
    'mobileKeys',
    'keysByHandle'
  ] as const) {
    for (const [key, value] of data[field]) {
      captured[field].set(key, new Set(value))
    }
  }
  for (const [key, value] of data.iconsByTab) {
    captured.iconsByTab.set(key, {
      ...value,
      live: new Set(value.live),
      done: new Set(value.done)
    })
  }
  const capturePanes = (panes: Record<string, ReadonlySet<string>>) =>
    Object.fromEntries(Object.entries(panes).map(([tab, ids]) => [tab, new Set(ids)]))
  for (const [key, value] of data.worktrees) {
    captured.worktrees.set(key, {
      ...value,
      keys: new Set(value.keys),
      counts: new Map(value.counts),
      attention: value.attention.map((heap) => heap.capture()),
      summary: {
        ...value.summary,
        agentStatusPaneIdsByTabId: capturePanes(value.summary.agentStatusPaneIdsByTabId),
        stalePaneIdsByTabId: capturePanes(value.summary.stalePaneIdsByTabId)
      }
    })
  }
  return captured
}
