import { describe, expect, it } from 'vitest'
import { normalizeAccumulatedWorkspaceFixtureOptions } from './accumulated-workspace-profile'
import { buildAccumulatedWorkspaceSeed } from './accumulated-workspace-state-builder'

describe('accumulated workspace state builder', () => {
  it('matches the captured production scale with canonical terminal identities', () => {
    const seed = buildAccumulatedWorkspaceSeed(
      normalizeAccumulatedWorkspaceFixtureOptions({}),
      1_700_000_000_000
    )
    const worktrees = Object.values(seed.worktreesByRepo).flat()
    const terminalTabs = Object.values(seed.tabsByWorktree).flat()
    const unifiedTabs = Object.values(seed.unifiedTabsByWorktree).flat()
    const unifiedTerminalTabs = unifiedTabs.filter(({ contentType }) => contentType === 'terminal')

    expect(seed.repos).toHaveLength(27)
    expect(worktrees).toHaveLength(870)
    expect(terminalTabs).toHaveLength(1_410)
    expect(unifiedTabs).toHaveLength(2_000)
    expect(Object.keys(seed.terminalLayoutsByTabId)).toHaveLength(1_410)
    expect(Object.keys(seed.sleepingAgentSessionsByPaneKey)).toHaveLength(857)
    expect(seed.liveStatuses).toHaveLength(177)
    expect(unifiedTerminalTabs.map(({ id }) => id)).toEqual(terminalTabs.map(({ id }) => id))
    expect(unifiedTerminalTabs.every(({ id, entityId }) => id === entityId)).toBe(true)
  })

  it('uses shallow independent lineage pairs instead of one synthetic chain', () => {
    const seed = buildAccumulatedWorkspaceSeed(normalizeAccumulatedWorkspaceFixtureOptions({}))
    const lineages = Object.values(seed.worktreeLineageById)
    const childIds = new Set(lineages.map(({ worktreeId }) => worktreeId))

    expect(lineages.length).toBeGreaterThan(0)
    expect(lineages.every(({ parentWorktreeId }) => !childIds.has(parentWorktreeId))).toBe(true)
  })

  // `lineageEvery: 1` means "every non-main worktree", but the interval check used
  // `% lineageEvery === 1`, which no ordinal satisfies at 1 — the fixture silently
  // built zero lineage records at the densest setting.
  it('builds lineage for every non-main worktree at an interval of 1', () => {
    const options = normalizeAccumulatedWorkspaceFixtureOptions({
      worktrees: 9,
      repositories: 3,
      lineageEvery: 1
    })
    const seed = buildAccumulatedWorkspaceSeed(options)
    const lineages = Object.values(seed.worktreeLineageById)

    // 9 worktrees over 3 repos gives ordinals 0..2 each; ordinal 0 is the main row.
    expect(lineages).toHaveLength(6)
  })
})
