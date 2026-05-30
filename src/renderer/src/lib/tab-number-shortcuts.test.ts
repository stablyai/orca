import { describe, expect, it } from 'vitest'
import type { Tab, TabGroup } from '../../../shared/types'
import type { AppState } from '@/store/types'
import { resolveTabNumberShortcutTarget } from './tab-number-shortcuts'

function tab(overrides: Partial<Tab> & Pick<Tab, 'id' | 'groupId'>): Tab {
  return {
    id: overrides.id,
    entityId: overrides.entityId ?? overrides.id,
    groupId: overrides.groupId,
    worktreeId: overrides.worktreeId ?? 'wt-1',
    contentType: overrides.contentType ?? 'terminal',
    label: overrides.label ?? overrides.id,
    customLabel: overrides.customLabel ?? null,
    color: overrides.color ?? null,
    sortOrder: overrides.sortOrder ?? 0,
    createdAt: overrides.createdAt ?? 0,
    isPreview: overrides.isPreview,
    isPinned: overrides.isPinned
  }
}

function state(overrides: {
  activeView?: AppState['activeView']
  activeWorktreeId?: string | null
  activeGroupId?: string
  groups?: TabGroup[]
  tabs?: Tab[]
}): Pick<
  AppState,
  | 'activeGroupIdByWorktree'
  | 'activeView'
  | 'activeWorktreeId'
  | 'groupsByWorktree'
  | 'unifiedTabsByWorktree'
> {
  const worktreeId = overrides.activeWorktreeId ?? 'wt-1'
  return {
    activeView: overrides.activeView ?? 'terminal',
    activeWorktreeId: worktreeId,
    activeGroupIdByWorktree:
      worktreeId === null ? {} : { [worktreeId]: overrides.activeGroupId ?? 'group-a' },
    groupsByWorktree: worktreeId === null ? {} : { [worktreeId]: overrides.groups ?? [] },
    unifiedTabsByWorktree: worktreeId === null ? {} : { [worktreeId]: overrides.tabs ?? [] }
  }
}

describe('resolveTabNumberShortcutTarget', () => {
  it('resolves by the active group tab order', () => {
    const first = tab({ id: 'tab-1', groupId: 'group-a' })
    const second = tab({ id: 'tab-2', groupId: 'group-a' })
    const third = tab({ id: 'tab-3', groupId: 'group-a' })

    expect(
      resolveTabNumberShortcutTarget(
        state({
          groups: [
            {
              id: 'group-a',
              worktreeId: 'wt-1',
              activeTabId: null,
              tabOrder: ['tab-2', 'tab-3', 'tab-1']
            }
          ],
          tabs: [first, second, third]
        }),
        1
      )
    ).toBe(third)
  })

  it('ignores stale duplicate ids and appends current group tabs missing from tabOrder', () => {
    const first = tab({ id: 'tab-1', groupId: 'group-a' })
    const second = tab({ id: 'tab-2', groupId: 'group-a' })

    expect(
      resolveTabNumberShortcutTarget(
        state({
          groups: [
            {
              id: 'group-a',
              worktreeId: 'wt-1',
              activeTabId: null,
              tabOrder: ['stale', 'tab-1', 'tab-1']
            }
          ],
          tabs: [first, second]
        }),
        1
      )
    ).toBe(second)
  })

  it('uses only the active split group', () => {
    const otherGroupTab = tab({ id: 'tab-other', groupId: 'group-a' })
    const activeGroupTab = tab({ id: 'tab-active', groupId: 'group-b' })

    expect(
      resolveTabNumberShortcutTarget(
        state({
          activeGroupId: 'group-b',
          groups: [
            { id: 'group-a', worktreeId: 'wt-1', activeTabId: null, tabOrder: ['tab-other'] },
            { id: 'group-b', worktreeId: 'wt-1', activeTabId: null, tabOrder: ['tab-active'] }
          ],
          tabs: [otherGroupTab, activeGroupTab]
        }),
        0
      )
    ).toBe(activeGroupTab)
  })

  it('returns null outside terminal workspaces or out of range', () => {
    const only = tab({ id: 'tab-1', groupId: 'group-a' })
    const base = state({
      groups: [{ id: 'group-a', worktreeId: 'wt-1', activeTabId: null, tabOrder: ['tab-1'] }],
      tabs: [only]
    })

    expect(resolveTabNumberShortcutTarget(base, 2)).toBeNull()
    expect(resolveTabNumberShortcutTarget({ ...base, activeView: 'settings' }, 0)).toBeNull()
    expect(resolveTabNumberShortcutTarget({ ...base, activeWorktreeId: null }, 0)).toBeNull()
    expect(resolveTabNumberShortcutTarget(base, -1)).toBeNull()
  })
})
