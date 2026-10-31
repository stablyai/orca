import { describe, expect, it } from 'vitest'
import {
  diffPersistedUIWriteFields,
  type PersistedUIWriteBaseline
} from './persisted-ui-write-baseline'

function makeBaseline(overrides: Partial<PersistedUIWriteBaseline> = {}): PersistedUIWriteBaseline {
  return {
    sidebarWidth: 280,
    sidebarOpen: true,
    rightSidebarOpen: true,
    rightSidebarTab: 'explorer',
    rightSidebarExplorerView: 'files',
    rightSidebarWidth: 350,
    markdownTocPanelWidth: 240,
    combinedDiffFileTreeWidth: 256,
    groupBy: 'repo',
    sortBy: 'recent',
    projectOrderBy: 'manual',
    showSleepingWorkspaces: true,
    workspaceHostScope: 'all',
    visibleWorkspaceHostIds: null,
    hideDefaultBranchWorkspace: false,
    hideAutomationGeneratedWorkspaces: false,
    hideCliCreatedWorkspaces: false,
    hideDetachedHeadWorkspaces: false,
    hideWorkspacesFromOtherDevices: false,
    alwaysShowDefaultBranchWorkspace: true,
    explorerDisplayRootByWorktree: {},
    showDotfilesByWorktree: {},
    filterRepoIds: [],
    acknowledgedAgentsByPaneKey: {},
    activityClearedAtByPaneKey: {},
    manuallyUnreadTurnsByPaneKey: {},
    ...overrides
  }
}

describe('diffPersistedUIWriteFields', () => {
  it('is empty when values are equal even across fresh array/record identities', () => {
    const a = makeBaseline({
      visibleWorkspaceHostIds: ['local', 'runtime:m4air'],
      filterRepoIds: ['r1', 'r2'],
      showDotfilesByWorktree: { w1: true },
      acknowledgedAgentsByPaneKey: { p1: 5 }
    })
    const b = makeBaseline({
      visibleWorkspaceHostIds: ['local', 'runtime:m4air'],
      filterRepoIds: ['r1', 'r2'],
      showDotfilesByWorktree: { w1: true },
      acknowledgedAgentsByPaneKey: { p1: 5 }
    })
    expect(diffPersistedUIWriteFields(a, b)).toEqual({})
  })

  it('distinguishes All hosts from a selected host list', () => {
    expect(
      diffPersistedUIWriteFields(
        makeBaseline({ visibleWorkspaceHostIds: null }),
        makeBaseline({ visibleWorkspaceHostIds: ['local'] })
      )
    ).toEqual({ visibleWorkspaceHostIds: null })
  })

  it('reports only the diverged fields, valued from the current mirror', () => {
    const baseline = makeBaseline()
    const current = makeBaseline({ showSleepingWorkspaces: false, filterRepoIds: ['r1'] })
    expect(diffPersistedUIWriteFields(current, baseline)).toEqual({
      showSleepingWorkspaces: false,
      filterRepoIds: ['r1']
    })
  })

  it('detects record content changes (added, removed, and re-valued keys)', () => {
    const baseline = makeBaseline({ acknowledgedAgentsByPaneKey: { p1: 5, p2: 6 } })
    expect(
      diffPersistedUIWriteFields(makeBaseline({ acknowledgedAgentsByPaneKey: { p1: 5 } }), baseline)
    ).toEqual({ acknowledgedAgentsByPaneKey: { p1: 5 } })
    expect(
      diffPersistedUIWriteFields(
        makeBaseline({ acknowledgedAgentsByPaneKey: { p1: 5, p2: 7 } }),
        baseline
      )
    ).toEqual({ acknowledgedAgentsByPaneKey: { p1: 5, p2: 7 } })
  })

  it('detects array order changes', () => {
    const baseline = makeBaseline({ filterRepoIds: ['r1', 'r2'] })
    const current = makeBaseline({ filterRepoIds: ['r2', 'r1'] })
    expect(diffPersistedUIWriteFields(current, baseline)).toEqual({ filterRepoIds: ['r2', 'r1'] })
  })
})
