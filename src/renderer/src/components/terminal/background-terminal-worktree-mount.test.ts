import { describe, expect, it, vi } from 'vitest'

import {
  addBackgroundMountedTerminalWorktree,
  applyBackgroundMountTabRestriction,
  hasRequestedBackgroundTerminalWorktreeMount,
  pruneClosedBackgroundMountTabs,
  requestBackgroundTerminalWorktreeMount,
  subscribeBackgroundTerminalWorktreeMountRequests,
  takeAllPendingBackgroundTerminalWorktreeMounts,
  shouldMountBackgroundWorktreeTab
} from './background-terminal-worktree-mount'

describe('background terminal mount request registry', () => {
  it('replays a request made before the Terminal listener mounts', () => {
    takeAllPendingBackgroundTerminalWorktreeMounts()
    const onRequest = vi.fn()
    const unsubscribe = subscribeBackgroundTerminalWorktreeMountRequests(onRequest)

    requestBackgroundTerminalWorktreeMount({ worktreeId: 'wt-cold', tabIds: ['tab-1'] })

    expect(hasRequestedBackgroundTerminalWorktreeMount()).toBe(true)
    expect(onRequest).toHaveBeenCalledOnce()
    expect(takeAllPendingBackgroundTerminalWorktreeMounts()).toEqual([
      { worktreeId: 'wt-cold', tabIds: ['tab-1'] }
    ])
    onRequest.mockClear()
    requestBackgroundTerminalWorktreeMount({ worktreeId: 'wt-later', tabIds: ['tab-2'] })
    expect(onRequest).not.toHaveBeenCalled()
    unsubscribe()
  })

  it('unions targeted requests and lets a whole-worktree request dominate', () => {
    takeAllPendingBackgroundTerminalWorktreeMounts()
    requestBackgroundTerminalWorktreeMount({ worktreeId: 'wt-1', tabIds: ['tab-1'] })
    requestBackgroundTerminalWorktreeMount({ worktreeId: 'wt-1', tabIds: ['tab-2'] })
    expect(takeAllPendingBackgroundTerminalWorktreeMounts()).toEqual([
      { worktreeId: 'wt-1', tabIds: ['tab-1', 'tab-2'] }
    ])

    requestBackgroundTerminalWorktreeMount({ worktreeId: 'wt-1', tabIds: ['tab-1'] })
    requestBackgroundTerminalWorktreeMount({ worktreeId: 'wt-1' })
    expect(takeAllPendingBackgroundTerminalWorktreeMounts()).toEqual([{ worktreeId: 'wt-1' }])
  })
})

describe('addBackgroundMountedTerminalWorktree', () => {
  it('adds a hidden worktree mount and notifies the caller once', () => {
    const mountedWorktreeIds = new Set<string>()
    const onAdded = vi.fn()

    expect(addBackgroundMountedTerminalWorktree(mountedWorktreeIds, 'wt-1', onAdded)).toBe(true)
    expect(mountedWorktreeIds.has('wt-1')).toBe(true)
    expect(onAdded).toHaveBeenCalledTimes(1)

    expect(addBackgroundMountedTerminalWorktree(mountedWorktreeIds, 'wt-1', onAdded)).toBe(false)
    expect(onAdded).toHaveBeenCalledTimes(1)
  })

  it('ignores missing worktree ids', () => {
    const mountedWorktreeIds = new Set<string>()
    const onAdded = vi.fn()

    expect(addBackgroundMountedTerminalWorktree(mountedWorktreeIds, undefined, onAdded)).toBe(false)
    expect(mountedWorktreeIds.size).toBe(0)
    expect(onAdded).not.toHaveBeenCalled()
  })
})

describe('applyBackgroundMountTabRestriction', () => {
  it('restricts a not-yet-mounted worktree to the targeted tabs and unions later targets', () => {
    const restrictions = new Map<string, ReadonlySet<string>>()
    const mounted = new Set<string>()

    applyBackgroundMountTabRestriction(restrictions, mounted, 'wt-1', ['tab-1'])
    expect(restrictions.get('wt-1')).toEqual(new Set(['tab-1']))

    mounted.add('wt-1')
    applyBackgroundMountTabRestriction(restrictions, mounted, 'wt-1', ['tab-2', 'tab-1'])
    expect(restrictions.get('wt-1')).toEqual(new Set(['tab-1', 'tab-2']))
  })

  it('never narrows a fully mounted worktree retroactively', () => {
    const restrictions = new Map<string, ReadonlySet<string>>()
    const mounted = new Set(['wt-visited'])

    applyBackgroundMountTabRestriction(restrictions, mounted, 'wt-visited', ['tab-1'])
    expect(restrictions.has('wt-visited')).toBe(false)
  })

  it('lifts the restriction on an untargeted (whole-worktree) mount', () => {
    const restrictions = new Map<string, ReadonlySet<string>>([['wt-1', new Set(['tab-1'])]])
    const mounted = new Set(['wt-1'])

    applyBackgroundMountTabRestriction(restrictions, mounted, 'wt-1', undefined)
    expect(restrictions.has('wt-1')).toBe(false)
  })

  it('keeps the existing set identity when the targets are already covered', () => {
    const existing = new Set(['tab-1', 'tab-2'])
    const restrictions = new Map<string, ReadonlySet<string>>([['wt-1', existing]])
    const mounted = new Set(['wt-1'])

    applyBackgroundMountTabRestriction(restrictions, mounted, 'wt-1', ['tab-2'])
    expect(restrictions.get('wt-1')).toBe(existing)
  })
})

describe('shouldMountBackgroundWorktreeTab', () => {
  it('mounts every tab without a restriction and only listed tabs with one', () => {
    expect(shouldMountBackgroundWorktreeTab(null, 'tab-1')).toBe(true)
    expect(shouldMountBackgroundWorktreeTab(new Set(['tab-1']), 'tab-1')).toBe(true)
    expect(shouldMountBackgroundWorktreeTab(new Set(['tab-1']), 'tab-2')).toBe(false)
  })
})

describe('pruneClosedBackgroundMountTabs', () => {
  it('retains live targets and releases the mount after the final target closes', () => {
    const restrictions = new Map<string, ReadonlySet<string>>([
      ['wt-1', new Set(['tab-1', 'tab-2'])]
    ])
    const mounted = new Set(['wt-1'])

    expect(
      pruneClosedBackgroundMountTabs(restrictions, mounted, {
        'wt-1': [{ id: 'tab-2' }, { id: 'unrelated-tab' }]
      })
    ).toBe(true)
    expect(restrictions.get('wt-1')).toEqual(new Set(['tab-2']))
    expect(mounted.has('wt-1')).toBe(true)

    expect(pruneClosedBackgroundMountTabs(restrictions, mounted, { 'wt-1': [] })).toBe(true)
    expect(restrictions.has('wt-1')).toBe(false)
    expect(mounted.has('wt-1')).toBe(false)
  })

  it('leaves unrestricted user-visited and whole-worktree mounts alone', () => {
    const restrictions = new Map<string, ReadonlySet<string>>()
    const mounted = new Set(['wt-visited', 'wt-whole'])

    expect(pruneClosedBackgroundMountTabs(restrictions, mounted, {})).toBe(false)
    expect(mounted).toEqual(new Set(['wt-visited', 'wt-whole']))
  })
})
