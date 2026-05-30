import { describe, expect, it, vi } from 'vitest'
import { applyLayoutSeed, planLayoutSeed, resolveTargetGroup } from './layout-rules'
import type { LayoutConfig } from '../../../shared/orca-yaml-layout'
import type { TabGroup } from '../../../shared/types'

const WT = 'repo1::/tmp/wt'

describe('resolveTargetGroup', () => {
  it('returns explicitGroupId when provided AND matches a real group', () => {
    const groups: Record<string, TabGroup[]> = {
      [WT]: [{ id: 'g1', worktreeId: WT, activeTabId: null, tabOrder: [] }]
    }
    expect(
      resolveTargetGroup({
        worktreeId: WT,
        contentKind: 'terminal',
        explicitGroupId: 'g1',
        groupsByWorktree: groups,
        layoutConfigByWorktree: {},
        layoutGroupIdByName: {}
      })
    ).toBe('g1')
  })

  it('overrides explicit groupId when target group kind locks a different content type', () => {
    // Layout has browser group locked to `kind: browser`. Caller asks
    // to create a terminal in that group → resolver redirects to the
    // group declared by rules['new-terminal'].
    const config: LayoutConfig = {
      groups: {
        editor: { position: 'left-top', kind: 'editor' },
        terminal: { position: 'left-bottom', kind: 'terminal' },
        browser: { position: 'right', kind: 'browser' }
      },
      rules: { 'new-terminal': 'terminal' }
    }
    const groups: Record<string, TabGroup[]> = {
      [WT]: [
        { id: 'gE', worktreeId: WT, activeTabId: null, tabOrder: [] },
        { id: 'gT', worktreeId: WT, activeTabId: null, tabOrder: [] },
        { id: 'gB', worktreeId: WT, activeTabId: null, tabOrder: [] }
      ]
    }
    expect(
      resolveTargetGroup({
        worktreeId: WT,
        contentKind: 'terminal',
        explicitGroupId: 'gB', // user clicked + in browser group
        groupsByWorktree: groups,
        layoutConfigByWorktree: { [WT]: config },
        layoutGroupIdByName: { [WT]: { editor: 'gE', terminal: 'gT', browser: 'gB' } }
      })
    ).toBe('gT') // → redirected to terminal group via rule
  })

  it('respects explicit groupId when group kind is mixed (or unset)', () => {
    const config: LayoutConfig = {
      groups: { mixedGroup: { position: 'center' } }, // no `kind`
      rules: { 'new-terminal': 'mixedGroup' }
    }
    const groups: Record<string, TabGroup[]> = {
      [WT]: [{ id: 'gM', worktreeId: WT, activeTabId: null, tabOrder: [] }]
    }
    expect(
      resolveTargetGroup({
        worktreeId: WT,
        contentKind: 'browser',
        explicitGroupId: 'gM',
        groupsByWorktree: groups,
        layoutConfigByWorktree: { [WT]: config },
        layoutGroupIdByName: { [WT]: { mixedGroup: 'gM' } }
      })
    ).toBe('gM') // mixed group — no override
  })

  it('ignores explicitGroupId when group does not exist (defensive)', () => {
    expect(
      resolveTargetGroup({
        worktreeId: WT,
        contentKind: 'terminal',
        explicitGroupId: 'g-stale',
        groupsByWorktree: { [WT]: [] },
        layoutConfigByWorktree: {},
        layoutGroupIdByName: {}
      })
    ).toBeUndefined()
  })

  it('resolves rule when no explicit and rule maps content kind to a known group', () => {
    const config: LayoutConfig = {
      groups: { terminal: { position: 'left-bottom' } },
      rules: { 'new-terminal': 'terminal' }
    }
    expect(
      resolveTargetGroup({
        worktreeId: WT,
        contentKind: 'terminal',
        explicitGroupId: null,
        groupsByWorktree: {
          [WT]: [{ id: 'gT', worktreeId: WT, activeTabId: null, tabOrder: [] }]
        },
        layoutConfigByWorktree: { [WT]: config },
        layoutGroupIdByName: { [WT]: { terminal: 'gT' } }
      })
    ).toBe('gT')
  })

  it('falls back to a kind-allowing group when no rule matches the content kind', () => {
    // When there's no rule for terminal but the only group is mixed
    // (no kind declared), the resolver falls back to it instead of
    // returning undefined and stranding the tab in a kind-locked active.
    const config: LayoutConfig = {
      groups: { browser: { position: 'right' } },
      rules: { 'new-browser-tab': 'browser' }
    }
    expect(
      resolveTargetGroup({
        worktreeId: WT,
        contentKind: 'terminal',
        explicitGroupId: null,
        groupsByWorktree: {
          [WT]: [{ id: 'gB', worktreeId: WT, activeTabId: null, tabOrder: [] }]
        },
        layoutConfigByWorktree: { [WT]: config },
        layoutGroupIdByName: { [WT]: { browser: 'gB' } }
      })
    ).toBe('gB')
  })

  it('skips a kind-locked active group when its kind rejects the new content', () => {
    // Active group is kind-locked to editor; creating a terminal must
    // NOT land there. With no terminal-allowing group available the
    // resolver returns undefined (caller's first-group fallback decides).
    const config: LayoutConfig = {
      groups: { editor: { position: 'left-top', kind: 'editor' } }
    }
    expect(
      resolveTargetGroup({
        worktreeId: WT,
        contentKind: 'terminal',
        explicitGroupId: null,
        activeGroupId: 'gE',
        groupsByWorktree: {
          [WT]: [{ id: 'gE', worktreeId: WT, activeTabId: null, tabOrder: [] }]
        },
        layoutConfigByWorktree: { [WT]: config },
        layoutGroupIdByName: { [WT]: { editor: 'gE' } }
      })
    ).toBeUndefined()
  })

  it('returns undefined for unknown content kinds (settings, tasks)', () => {
    expect(
      resolveTargetGroup({
        worktreeId: WT,
        contentKind: 'settings',
        explicitGroupId: null,
        groupsByWorktree: {},
        layoutConfigByWorktree: {},
        layoutGroupIdByName: {}
      })
    ).toBeUndefined()
  })

  it('returns undefined when rule references a name not yet seeded', () => {
    const config: LayoutConfig = {
      groups: { browser: { position: 'right' } },
      rules: { 'new-browser-tab': 'browser' }
    }
    expect(
      resolveTargetGroup({
        worktreeId: WT,
        contentKind: 'browser',
        explicitGroupId: null,
        groupsByWorktree: { [WT]: [] },
        layoutConfigByWorktree: { [WT]: config },
        // Empty bindings — seed hasn't run yet
        layoutGroupIdByName: { [WT]: {} }
      })
    ).toBeUndefined()
  })
})

describe('planLayoutSeed', () => {
  it('returns null for config with no groups', () => {
    expect(planLayoutSeed({})).toBeNull()
    expect(planLayoutSeed({ groups: {} })).toBeNull()
  })

  it('produces an init op for a single-group config', () => {
    const plan = planLayoutSeed({
      groups: { only: { position: 'center' } }
    })
    expect(plan).not.toBeNull()
    expect(plan!.ops).toEqual([{ kind: 'init', name: 'only' }])
    expect(plan!.initialActiveGroupName).toBe('only')
  })

  it('plans the canonical 3-group layout (editor + terminal + browser)', () => {
    const plan = planLayoutSeed({
      groups: {
        editor: { position: 'left-top' },
        terminal: { position: 'left-bottom' },
        browser: { position: 'right' }
      },
      rules: {
        'new-editor-tab': 'editor',
        'new-terminal': 'terminal',
        'new-browser-tab': 'browser'
      }
    })
    expect(plan).not.toBeNull()
    expect(plan!.ops[0]).toEqual({ kind: 'init', name: 'editor' })
    // The remaining ops produce browser (right) and terminal (down).
    const splitOps = plan!.ops.filter((op) => op.kind === 'split')
    expect(splitOps.length).toBe(2)
    expect(plan!.initialActiveGroupName).toBe('terminal')
  })

  it('falls back initial-active-group to root when no rule[new-terminal]', () => {
    // Why: the planner picks root by partitioning shape — no left side
    // means right column is the only bucket; b becomes root, no center
    // emitted (center is treated as "implicit root content" when left
    // or right exist).
    const plan = planLayoutSeed({
      groups: { a: { position: 'center' }, b: { position: 'right' } }
    })
    expect(plan!.initialActiveGroupName).toBe('b')
  })
})

describe('applyLayoutSeed', () => {
  it('is a no-op when groups already exist for the worktree', () => {
    const ensureRoot = vi.fn().mockReturnValue('g0')
    const split = vi.fn().mockReturnValue('g1')
    const focus = vi.fn()
    const record = vi.fn()
    const result = applyLayoutSeed(
      WT,
      {
        groups: { only: { position: 'center' } }
      },
      {
        getGroupsForWorktree: () => [
          { id: 'g-existing', worktreeId: WT, activeTabId: null, tabOrder: [] }
        ],
        ensureWorktreeRootGroup: ensureRoot,
        createEmptySplitGroup: split,
        focusGroup: focus,
        recordLayoutGroupBinding: record
      }
    )
    expect(result).toBe(false)
    expect(ensureRoot).not.toHaveBeenCalled()
    expect(split).not.toHaveBeenCalled()
  })

  it('seeds a single-group layout: ensures root, records binding, focuses it', () => {
    const ensureRoot = vi.fn().mockReturnValue('g0')
    const split = vi.fn()
    const focus = vi.fn()
    const record = vi.fn()
    const result = applyLayoutSeed(
      WT,
      { groups: { main: { position: 'center' } } },
      {
        getGroupsForWorktree: () => [],
        ensureWorktreeRootGroup: ensureRoot,
        createEmptySplitGroup: split,
        focusGroup: focus,
        recordLayoutGroupBinding: record
      }
    )
    expect(result).toBe(true)
    expect(ensureRoot).toHaveBeenCalledWith(WT)
    expect(split).not.toHaveBeenCalled()
    expect(record).toHaveBeenCalledWith(WT, 'main', 'g0')
    expect(focus).toHaveBeenCalledWith(WT, 'g0')
  })

  it('seeds the canonical 3-group layout end-to-end', () => {
    const ensureRoot = vi.fn().mockReturnValue('g-editor')
    let splitCallCounter = 0
    // Why: planner partitions by axis — outer right column FIRST (so
    // browser carves the full right side), then sub-split inside left
    // column for terminal. Sequence: init editor → split RIGHT to
    // browser → split DOWN to terminal.
    const splitIds = ['g-browser', 'g-terminal']
    const split = vi.fn().mockImplementation(() => splitIds[splitCallCounter++])
    const focus = vi.fn()
    const bindings: [string, string, string][] = []
    const record = vi.fn().mockImplementation((wt, name, id) => {
      bindings.push([wt, name, id])
    })
    const result = applyLayoutSeed(
      WT,
      {
        groups: {
          editor: { position: 'left-top' },
          terminal: { position: 'left-bottom' },
          browser: { position: 'right' }
        },
        rules: { 'new-terminal': 'terminal' }
      },
      {
        getGroupsForWorktree: () => [],
        ensureWorktreeRootGroup: ensureRoot,
        createEmptySplitGroup: split,
        focusGroup: focus,
        recordLayoutGroupBinding: record
      }
    )
    expect(result).toBe(true)
    expect(ensureRoot).toHaveBeenCalledTimes(1)
    expect(split).toHaveBeenCalledTimes(2)
    // Bindings order matches emit order: root (editor), then right
    // column (browser), then inner-left split (terminal).
    expect(bindings.map(([, name]) => name)).toEqual(['editor', 'browser', 'terminal'])
    // initialActive (rule['new-terminal'] = terminal) → focus on g-terminal
    expect(focus).toHaveBeenCalledWith(WT, 'g-terminal')
  })
})
