import { describe, expect, it } from 'vitest'
import {
  PERSISTED_UI_WRITE_BASELINE_FIELDS,
  capturePersistedUIWriteBaseline,
  diffPersistedUIWriteFields,
  persistedUIWriteFieldsToWireUpdate,
  type PersistedUIWriteBaseline
} from './persisted-ui-write-baseline'

function makeBaseline(overrides: Partial<PersistedUIWriteBaseline> = {}): PersistedUIWriteBaseline {
  return {
    sidebarWidth: 280,
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
    hideDefaultBranchWorkspace: false,
    hideAutomationGeneratedWorkspaces: false,
    hideCliCreatedWorkspaces: false,
    hideDetachedHeadWorkspaces: false,
    hideWorkspacesFromOtherDevices: false,
    alwaysShowDefaultBranchWorkspace: true,
    showDotfilesByWorktree: {},
    filterRepoIds: [],
    acknowledgedAgentsByPaneKey: {},
    activityClearedAtByPaneKey: {},
    manuallyUnreadTurnsByPaneKey: {},
    ...overrides
  }
}

describe('capturePersistedUIWriteBaseline', () => {
  it('picks exactly the writer-owned fields off a superset', () => {
    const superset = { ...makeBaseline(), persistedUIReady: true, repos: [] }
    const captured = capturePersistedUIWriteBaseline(superset)
    expect(Object.keys(captured).sort()).toEqual([...PERSISTED_UI_WRITE_BASELINE_FIELDS].sort())
  })
})

describe('PERSISTED_UI_WRITE_BASELINE_FIELDS', () => {
  it('covers every writer-owned field (runtime census, independent of the impl list)', () => {
    // makeBaseline is a full literal maintained separately from the impl's field
    // set; a field dropped from the impl list fails here even when tc is skipped.
    expect([...PERSISTED_UI_WRITE_BASELINE_FIELDS].sort()).toEqual(
      Object.keys(makeBaseline()).sort()
    )
  })
})

describe('diffPersistedUIWriteFields', () => {
  it('is empty when values are equal even across fresh array/record identities', () => {
    const a = makeBaseline({
      filterRepoIds: ['r1', 'r2'],
      showDotfilesByWorktree: { w1: true },
      acknowledgedAgentsByPaneKey: { p1: 5 }
    })
    const b = makeBaseline({
      filterRepoIds: ['r1', 'r2'],
      showDotfilesByWorktree: { w1: true },
      acknowledgedAgentsByPaneKey: { p1: 5 }
    })
    expect(diffPersistedUIWriteFields(a, b)).toEqual({})
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

describe('manuallyUnreadTurnsByPaneKey write round-trip', () => {
  it('is writer-owned and diffs by record content like the other pane-key records', () => {
    expect(PERSISTED_UI_WRITE_BASELINE_FIELDS).toContain('manuallyUnreadTurnsByPaneKey')
    const baseline = makeBaseline({ manuallyUnreadTurnsByPaneKey: { p1: 5 } })
    expect(
      diffPersistedUIWriteFields(
        makeBaseline({ manuallyUnreadTurnsByPaneKey: { p1: 5 } }),
        baseline
      )
    ).toEqual({})
    expect(
      diffPersistedUIWriteFields(
        makeBaseline({ manuallyUnreadTurnsByPaneKey: { p1: 7 } }),
        baseline
      )
    ).toEqual({ manuallyUnreadTurnsByPaneKey: { p1: 7 } })
    expect(persistedUIWriteFieldsToWireUpdate({ manuallyUnreadTurnsByPaneKey: { p1: 7 } })).toEqual(
      { manuallyUnreadTurnsByPaneKey: { p1: 7 } }
    )
  })
})

describe('persistedUIWriteFieldsToWireUpdate', () => {
  it('inverts showSleepingWorkspaces to the durable hide form', () => {
    expect(persistedUIWriteFieldsToWireUpdate({ showSleepingWorkspaces: true })).toEqual({
      hideSleepingWorkspaces: false
    })
    expect(persistedUIWriteFieldsToWireUpdate({ showSleepingWorkspaces: false })).toEqual({
      hideSleepingWorkspaces: true
    })
  })

  it('copies filterRepoIds so main never receives the readonly store array', () => {
    const filterRepoIds = ['r1']
    const update = persistedUIWriteFieldsToWireUpdate({ filterRepoIds })
    expect(update.filterRepoIds).toEqual(['r1'])
    expect(update.filterRepoIds).not.toBe(filterRepoIds)
  })

  it('passes same-name fields through and never invents keys', () => {
    const update = persistedUIWriteFieldsToWireUpdate({
      hideDefaultBranchWorkspace: true,
      groupBy: 'none'
    })
    expect(update).toEqual({ hideDefaultBranchWorkspace: true, groupBy: 'none' })
  })
})
