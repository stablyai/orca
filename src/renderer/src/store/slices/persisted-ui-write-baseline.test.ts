import { describe, expect, it } from 'vitest'
import {
  PERSISTED_UI_WRITE_BASELINE_FIELDS,
  capturePersistedUIWriteBaseline,
  diffPersistedUIWriteFields,
  persistedUIWriteFieldsToWireUpdate,
  quarantineRejectedPersistedUIWriteFields,
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
    sessionsGridPreset: '2x2',
    sessionsGridZoom: 1,
    sessionsGridShowEmpty: true,
    sessionsGridFilter: 'all',
    sessionsGridStateFilter: 'all',
    sessionsGridScrollMode: 'row',
    sessionsGridWheelTarget: 'auto',
    sessionsGridTabOrder: [],
    sessionsGridHiddenTabIds: [],
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

describe('session grid fields', () => {
  it('diffs the order array by value, so a fresh but equal array is not a local edit', () => {
    const baseline = makeBaseline({ sessionsGridTabOrder: ['a', 'b'] })
    const current = makeBaseline({ sessionsGridTabOrder: ['a', 'b'] })
    expect(diffPersistedUIWriteFields(current, baseline)).toEqual({})
    expect(
      diffPersistedUIWriteFields(makeBaseline({ sessionsGridTabOrder: ['b', 'a'] }), baseline)
    ).toEqual({ sessionsGridTabOrder: ['b', 'a'] })
  })

  it('diffs the hidden list by value, so a fresh but equal array is not a local edit', () => {
    const baseline = makeBaseline({ sessionsGridHiddenTabIds: ['a', 'b'] })
    const current = makeBaseline({ sessionsGridHiddenTabIds: ['a', 'b'] })
    expect(diffPersistedUIWriteFields(current, baseline)).toEqual({})
    expect(
      diffPersistedUIWriteFields(makeBaseline({ sessionsGridHiddenTabIds: ['a'] }), baseline)
    ).toEqual({ sessionsGridHiddenTabIds: ['a'] })
  })

  it('ships every grid field under its own name on the wire', () => {
    expect(
      persistedUIWriteFieldsToWireUpdate({
        sessionsGridPreset: '3x2',
        sessionsGridZoom: 1.2,
        sessionsGridShowEmpty: false,
        sessionsGridFilter: 'wt-1',
        sessionsGridStateFilter: 'attention',
        sessionsGridScrollMode: 'page',
        sessionsGridWheelTarget: 'grid',
        sessionsGridTabOrder: ['a'],
        sessionsGridHiddenTabIds: ['b']
      })
    ).toEqual({
      sessionsGridPreset: '3x2',
      sessionsGridZoom: 1.2,
      sessionsGridShowEmpty: false,
      sessionsGridFilter: 'wt-1',
      sessionsGridStateFilter: 'attention',
      sessionsGridScrollMode: 'page',
      sessionsGridWheelTarget: 'grid',
      sessionsGridTabOrder: ['a'],
      sessionsGridHiddenTabIds: ['b']
    })
  })
})

describe('quarantineRejectedPersistedUIWriteFields', () => {
  it('leaves a transport failure alone so the fields stay dirty for the next edit', () => {
    expect(
      quarantineRejectedPersistedUIWriteFields(new Error('transport failure'), {
        sidebarWidth: 300
      })
    ).toBeNull()
    expect(
      quarantineRejectedPersistedUIWriteFields(
        Object.assign(new Error('offline'), { code: 'runtime_manually_disconnected' }),
        { sessionsGridZoom: 1.2 }
      )
    ).toBeNull()
  })

  it('quarantines exactly the keys a strict host names, leaving batch-mates dirty', () => {
    const error = Object.assign(
      new Error('Unrecognized keys: "sessionsGridZoom", "sessionsGridTabOrder"'),
      {
        code: 'invalid_argument'
      }
    )
    expect(
      quarantineRejectedPersistedUIWriteFields(error, {
        sidebarWidth: 300,
        sessionsGridZoom: 1.2,
        sessionsGridTabOrder: ['a']
      })
    ).toEqual({ sessionsGridZoom: 1.2, sessionsGridTabOrder: ['a'] })
  })

  it('matches a named key by its wire name, not the mirror name', () => {
    const error = Object.assign(new Error('Unrecognized key: "hideSleepingWorkspaces"'), {
      code: 'invalid_argument'
    })
    expect(
      quarantineRejectedPersistedUIWriteFields(error, {
        showSleepingWorkspaces: false,
        sidebarWidth: 300
      })
    ).toEqual({ showSleepingWorkspaces: false })
  })

  it('falls back to the host-gated members when the message names no key', () => {
    const error = Object.assign(new Error('invalid_argument'), { code: 'invalid_argument' })
    expect(
      quarantineRejectedPersistedUIWriteFields(error, {
        sidebarWidth: 300,
        sessionsGridPreset: '3x2'
      })
    ).toEqual({ sessionsGridPreset: '3x2' })
  })

  it('quarantines the whole batch when nothing narrower can be blamed', () => {
    const error = Object.assign(new Error('invalid_argument'), { code: 'invalid_argument' })
    expect(
      quarantineRejectedPersistedUIWriteFields(error, { sidebarWidth: 300, groupBy: 'none' })
    ).toEqual({ sidebarWidth: 300, groupBy: 'none' })
  })
})
