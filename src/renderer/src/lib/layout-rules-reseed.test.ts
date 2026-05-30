import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MockInstance } from 'vitest'
import { planLayoutSeed, tryReseedAfterLateConfigArrival } from './layout-rules'
import type { TabGroup } from '../../../shared/types'

const WT = 'repo1::/tmp/wt'

describe('tryReseedAfterLateConfigArrival', () => {
  const sampleConfig = {
    groups: {
      editor: { position: 'left-top' as const },
      terminal: { position: 'left-bottom' as const },
      browser: { position: 'right' as const }
    },
    rules: {
      'new-editor-tab': 'editor',
      'new-terminal': 'terminal',
      'new-browser-tab': 'browser'
    }
  }

  // Why: simulates Zustand's set() semantics — every "mutation" reallocates
  // the top-level by-worktree maps so reads through the thunk see the
  // current state and nothing aliases stale frozen references.
  function makeActions(opts: {
    groups?: TabGroup[]
    tabs?: { id: string; pendingActivationSpawn?: boolean }[]
  }) {
    let groupsByWorktree: Record<string, TabGroup[]> = { [WT]: opts.groups ?? [] }
    let tabsByWorktree: Record<
      string,
      { id: string; pendingActivationSpawn?: boolean }[]
    > = { [WT]: opts.tabs ?? [] }

    const closeTab = vi.fn().mockImplementation((tabId: string) => {
      tabsByWorktree = {
        ...tabsByWorktree,
        [WT]: (tabsByWorktree[WT] ?? []).filter((t) => t.id !== tabId)
      }
    })
    const closeEmptyGroup = vi.fn().mockImplementation((wt: string, gid: string) => {
      groupsByWorktree = {
        ...groupsByWorktree,
        [wt]: (groupsByWorktree[wt] ?? []).filter((g) => g.id !== gid)
      }
      return true
    })
    const recreate = vi.fn()
    const ensureRoot = vi.fn().mockImplementation((wt: string) => {
      const id = 'g-editor'
      groupsByWorktree = {
        ...groupsByWorktree,
        [wt]: [
          ...(groupsByWorktree[wt] ?? []),
          { id, worktreeId: wt, activeTabId: null, tabOrder: [] }
        ]
      }
      return id
    })
    let splitIdx = 0
    const splitIds = ['g-browser', 'g-terminal']
    const split = vi.fn().mockImplementation((wt: string) => {
      const id = splitIds[splitIdx++]
      groupsByWorktree = {
        ...groupsByWorktree,
        [wt]: [
          ...(groupsByWorktree[wt] ?? []),
          { id, worktreeId: wt, activeTabId: null, tabOrder: [] }
        ]
      }
      return id
    })
    const focus = vi.fn()
    const record = vi.fn()
    return {
      closeTab,
      closeEmptyGroup,
      recreate,
      ensureRoot,
      split,
      focus,
      record,
      actions: {
        getGroupsForWorktree: (wt: string) => groupsByWorktree[wt] ?? [],
        getTabsForWorktree: (wt: string) => tabsByWorktree[wt] ?? [],
        ensureWorktreeRootGroup: ensureRoot,
        createEmptySplitGroup: split,
        focusGroup: focus,
        recordLayoutGroupBinding: record,
        closeTab,
        closeEmptyGroup,
        recreateInitialTerminal: recreate
      }
    }
  }

  it('reseeds when state is single default group + auto-spawn terminal', () => {
    const m = makeActions({
      groups: [{ id: 'g-default', worktreeId: WT, activeTabId: 't1', tabOrder: ['t1'] }],
      tabs: [{ id: 't1', pendingActivationSpawn: true }]
    })
    const result = tryReseedAfterLateConfigArrival(WT, sampleConfig, m.actions)
    expect(result).toBe(true)
    expect(m.closeTab).toHaveBeenCalledWith('t1')
    expect(m.closeEmptyGroup).toHaveBeenCalledWith(WT, 'g-default')
    expect(m.recreate).toHaveBeenCalledWith(WT)
  })

  it('skips when worktree already has > 1 group (user split it)', () => {
    const m = makeActions({
      groups: [
        { id: 'g1', worktreeId: WT, activeTabId: null, tabOrder: [] },
        { id: 'g2', worktreeId: WT, activeTabId: null, tabOrder: [] }
      ],
      tabs: [{ id: 't1', pendingActivationSpawn: true }]
    })
    expect(tryReseedAfterLateConfigArrival(WT, sampleConfig, m.actions)).toBe(false)
    expect(m.closeTab).not.toHaveBeenCalled()
  })

  it('skips when user added more tabs than the auto-spawn', () => {
    const m = makeActions({
      groups: [{ id: 'g-default', worktreeId: WT, activeTabId: null, tabOrder: [] }],
      tabs: [
        { id: 't1', pendingActivationSpawn: true },
        { id: 't2' }
      ]
    })
    expect(tryReseedAfterLateConfigArrival(WT, sampleConfig, m.actions)).toBe(false)
    expect(m.closeTab).not.toHaveBeenCalled()
  })

  it('skips when the lone tab is user-created (no pendingActivationSpawn)', () => {
    const m = makeActions({
      groups: [{ id: 'g-default', worktreeId: WT, activeTabId: 't1', tabOrder: ['t1'] }],
      tabs: [{ id: 't1' }]
    })
    expect(tryReseedAfterLateConfigArrival(WT, sampleConfig, m.actions)).toBe(false)
    expect(m.closeTab).not.toHaveBeenCalled()
  })

  it('reseeds even with no tabs (group exists but never spawned)', () => {
    const m = makeActions({
      groups: [{ id: 'g-default', worktreeId: WT, activeTabId: null, tabOrder: [] }],
      tabs: []
    })
    expect(tryReseedAfterLateConfigArrival(WT, sampleConfig, m.actions)).toBe(true)
    expect(m.closeTab).not.toHaveBeenCalled()
    expect(m.closeEmptyGroup).toHaveBeenCalledWith(WT, 'g-default')
    expect(m.recreate).toHaveBeenCalledWith(WT)
  })
})

describe('planner edge cases', () => {
  let warn: MockInstance<typeof console.warn>
  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    warn.mockRestore()
  })

  it('does not silently drop standalone left + top + bottom', () => {
    const plan = planLayoutSeed({
      groups: {
        a: { position: 'left' },
        b: { position: 'top' },
        c: { position: 'bottom' }
      }
    })
    expect(plan).not.toBeNull()
    const opNames = plan!.ops.flatMap((op) =>
      op.kind === 'init' ? [op.name] : [op.newName]
    )
    expect(new Set(opNames)).toEqual(new Set(['a', 'b', 'c']))
  })

  it('handles vertical-only layout (top + bottom, no sides)', () => {
    const plan = planLayoutSeed({
      groups: {
        header: { position: 'top' },
        body: { position: 'bottom' }
      }
    })
    expect(plan).not.toBeNull()
    expect(plan!.ops).toHaveLength(2)
    expect(plan!.ops[0]).toMatchObject({ kind: 'init' })
    expect(plan!.ops[1]).toMatchObject({ kind: 'split' })
  })

  it('warns (and skips) center declared alongside outer groups', () => {
    const plan = planLayoutSeed({
      groups: {
        editor: { position: 'left-top' },
        scratch: { position: 'center' }
      }
    })
    expect(plan).not.toBeNull()
    const opNames = plan!.ops.flatMap((op) =>
      op.kind === 'init' ? [op.name] : [op.newName]
    )
    expect(opNames).not.toContain('scratch')
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('scratch'))
  })
})
