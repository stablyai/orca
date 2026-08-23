import { describe, expect, it } from 'vitest'
import {
  resolveWebSessionSiblingVisibleTabId,
  resolveWebSessionVisibleTabId
} from './web-session-focus-intent'
import {
  toVisibleTabType,
  type Tab,
  type TabContentType,
  type TabGroup
} from '../../../shared/tab-types'
import { makeState, WT } from './web-session-tabs-sync-test-harness'

const GROUP_A = 'group-a'
const GROUP_B = 'group-b'

function tab(overrides: Partial<Tab> & Pick<Tab, 'id' | 'entityId' | 'contentType'>): Tab {
  return {
    groupId: GROUP_A,
    worktreeId: WT,
    label: overrides.id,
    sortOrder: 0,
    ...overrides
  } as Tab
}

function group(overrides: Partial<TabGroup> & Pick<TabGroup, 'id'>): TabGroup {
  return {
    worktreeId: WT,
    activeTabId: null,
    tabOrder: [],
    ...overrides
  }
}

describe('resolveWebSessionVisibleTabId — grouped state is authoritative', () => {
  // Why: the bug. Diff tabs carry contentType 'diff' while the coarse address says 'editor'.
  it.each<TabContentType>(['diff', 'conflict-review', 'check-details'])(
    'resolves a focused %s tab instead of returning null',
    (contentType) => {
      const visible = tab({ id: 'tab-1', entityId: 'file-1', contentType })
      const state = makeState({
        unifiedTabsByWorktree: { [WT]: [visible] },
        groupsByWorktree: {
          [WT]: [group({ id: GROUP_A, activeTabId: 'tab-1', tabOrder: ['tab-1'] })]
        },
        activeGroupIdByWorktree: { [WT]: GROUP_A },
        activeTabType: 'editor',
        activeTabTypeByWorktree: { [WT]: 'editor' },
        activeFileIdByWorktree: { [WT]: 'file-1' }
      })

      expect(resolveWebSessionVisibleTabId(state, WT)).toBe('tab-1')
    }
  )

  it('returns the group active tab, not the tab the stale coarse address names', () => {
    const shown = tab({ id: 'tab-shown', entityId: 'file-shown', contentType: 'editor' })
    const stale = tab({ id: 'tab-stale', entityId: 'file-stale', contentType: 'editor' })
    const state = makeState({
      unifiedTabsByWorktree: { [WT]: [stale, shown] },
      groupsByWorktree: {
        [WT]: [
          group({ id: GROUP_A, activeTabId: 'tab-shown', tabOrder: ['tab-stale', 'tab-shown'] })
        ]
      },
      activeGroupIdByWorktree: { [WT]: GROUP_A },
      activeTabType: 'editor',
      activeTabTypeByWorktree: { [WT]: 'editor' },
      // Why: activateTab writes group state only, so the legacy address lags behind.
      activeFileIdByWorktree: { [WT]: 'file-stale' }
    })

    expect(resolveWebSessionVisibleTabId(state, WT)).toBe('tab-shown')
  })

  // Why: copyUnifiedTabToGroup duplicates contentType + entityId into another group, so a plain
  // array scan can return the background copy and drag group focus to it.
  it('prefers the active group copy when one entity exists in two split groups', () => {
    const background = tab({
      id: 'tab-bg',
      entityId: 'file-1',
      contentType: 'diff',
      groupId: GROUP_A
    })
    const focused = tab({ id: 'tab-fg', entityId: 'file-1', contentType: 'diff', groupId: GROUP_B })
    const state = makeState({
      // Why: background copy first — array order must not decide.
      unifiedTabsByWorktree: { [WT]: [background, focused] },
      groupsByWorktree: {
        [WT]: [
          group({ id: GROUP_A, activeTabId: 'tab-bg', tabOrder: ['tab-bg'] }),
          group({ id: GROUP_B, activeTabId: 'tab-fg', tabOrder: ['tab-fg'] })
        ]
      },
      activeGroupIdByWorktree: { [WT]: GROUP_B },
      activeTabType: 'editor',
      activeTabTypeByWorktree: { [WT]: 'editor' },
      activeFileIdByWorktree: { [WT]: 'file-1' }
    })

    expect(resolveWebSessionVisibleTabId(state, WT)).toBe('tab-fg')
  })

  // Why: a focused empty split must not resolve into some other group. This pins the contract
  // only — it does NOT claim empty-split focus survives reconciliation (see plan scope boundary).
  it('returns null for a focused empty split rather than a background tab', () => {
    const background = tab({
      id: 'tab-bg',
      entityId: 'file-1',
      contentType: 'editor',
      groupId: GROUP_A
    })
    const state = makeState({
      unifiedTabsByWorktree: { [WT]: [background] },
      groupsByWorktree: {
        [WT]: [
          group({ id: GROUP_A, activeTabId: 'tab-bg', tabOrder: ['tab-bg'] }),
          group({ id: GROUP_B, activeTabId: null, tabOrder: [] })
        ]
      },
      activeGroupIdByWorktree: { [WT]: GROUP_B },
      // Why: plain 'editor' — a diff here would already return null pre-fix, making this vacuous.
      activeTabType: 'editor',
      activeTabTypeByWorktree: { [WT]: 'editor' },
      activeFileIdByWorktree: { [WT]: 'file-1' }
    })

    expect(resolveWebSessionVisibleTabId(state, WT)).toBeNull()
  })

  it('ignores a tab whose groupId disagrees with the active group', () => {
    const mismatched = tab({
      id: 'tab-1',
      entityId: 'file-1',
      contentType: 'diff',
      groupId: GROUP_B
    })
    const state = makeState({
      unifiedTabsByWorktree: { [WT]: [mismatched] },
      groupsByWorktree: {
        [WT]: [group({ id: GROUP_A, activeTabId: 'tab-1', tabOrder: ['tab-1'] })]
      },
      activeGroupIdByWorktree: { [WT]: GROUP_A }
    })

    expect(resolveWebSessionVisibleTabId(state, WT)).toBeNull()
  })

  // Why: reconcile replaces a local tab with a mirrored one under a new id; focus must follow the
  // entity instead of being dropped (which would hand activation to the snapshot).
  it('follows the entity when the visible tab is rematerialized under a new id', () => {
    const local = tab({ id: 'local-editor', entityId: '/repo/index.html', contentType: 'editor' })
    const mirrored = tab({ id: 'host-editor', entityId: '/repo/index.html', contentType: 'editor' })
    const state = makeState({
      unifiedTabsByWorktree: { [WT]: [local] },
      groupsByWorktree: {
        [WT]: [group({ id: GROUP_A, activeTabId: 'local-editor', tabOrder: ['local-editor'] })]
      },
      activeGroupIdByWorktree: { [WT]: GROUP_A }
    })

    // Why: the post-materialization tab set no longer contains the local id.
    expect(resolveWebSessionVisibleTabId(state, WT, [mirrored])).toBe('host-editor')
  })

  it('does not follow a rematerialized entity into a different group', () => {
    const local = tab({ id: 'local-editor', entityId: '/repo/index.html', contentType: 'editor' })
    const elsewhere = tab({
      id: 'host-editor',
      entityId: '/repo/index.html',
      contentType: 'editor',
      groupId: GROUP_B
    })
    const state = makeState({
      unifiedTabsByWorktree: { [WT]: [local] },
      groupsByWorktree: {
        [WT]: [group({ id: GROUP_A, activeTabId: 'local-editor', tabOrder: ['local-editor'] })]
      },
      activeGroupIdByWorktree: { [WT]: GROUP_A }
    })

    expect(resolveWebSessionVisibleTabId(state, WT, [elsewhere])).toBeNull()
  })

  it('falls back to the first group when the active group id is stale', () => {
    const visible = tab({ id: 'tab-1', entityId: 'file-1', contentType: 'diff' })
    const state = makeState({
      unifiedTabsByWorktree: { [WT]: [visible] },
      groupsByWorktree: {
        [WT]: [group({ id: GROUP_A, activeTabId: 'tab-1', tabOrder: ['tab-1'] })]
      },
      activeGroupIdByWorktree: { [WT]: 'group-that-no-longer-exists' }
    })

    expect(resolveWebSessionVisibleTabId(state, WT)).toBe('tab-1')
  })
})

describe('resolveWebSessionVisibleTabId — no-group compatibility path', () => {
  it('resolves a diff through the projection when there are no group records', () => {
    const visible = tab({ id: 'tab-1', entityId: 'file-1', contentType: 'diff' })
    const state = makeState({
      unifiedTabsByWorktree: { [WT]: [visible] },
      groupsByWorktree: {},
      activeTabType: 'editor',
      activeTabTypeByWorktree: { [WT]: 'editor' },
      activeFileIdByWorktree: { [WT]: 'file-1' }
    })

    expect(resolveWebSessionVisibleTabId(state, WT)).toBe('tab-1')
  })

  it('keeps remembered-terminal behaviour when there are no group records', () => {
    const terminal = tab({ id: 'term-1', entityId: 'term-1', contentType: 'terminal' })
    const state = makeState({
      unifiedTabsByWorktree: { [WT]: [terminal] },
      groupsByWorktree: {},
      activeTabType: 'terminal',
      activeTabTypeByWorktree: { [WT]: 'terminal' },
      activeTabIdByWorktree: { [WT]: 'term-1' }
    })

    expect(resolveWebSessionVisibleTabId(state, WT)).toBe('term-1')
  })

  it('does not match a browser tab against an editor coarse address', () => {
    const browser = tab({ id: 'tab-1', entityId: 'ws-1', contentType: 'browser' })
    const state = makeState({
      unifiedTabsByWorktree: { [WT]: [browser] },
      groupsByWorktree: {},
      activeTabType: 'editor',
      activeTabTypeByWorktree: { [WT]: 'editor' },
      activeFileIdByWorktree: { [WT]: 'ws-1' }
    })

    expect(resolveWebSessionVisibleTabId(state, WT)).toBeNull()
  })
})

describe('resolveWebSessionSiblingVisibleTabId', () => {
  it('returns the sibling whose active tab matches the remembered visible type', () => {
    const editor = tab({ id: 'tab-editor', entityId: 'file-1', contentType: 'editor' })
    const terminal = tab({
      id: 'tab-terminal',
      entityId: 'term-1',
      contentType: 'terminal',
      groupId: GROUP_B
    })
    const state = makeState({
      unifiedTabsByWorktree: { [WT]: [editor, terminal] },
      groupsByWorktree: {
        [WT]: [
          group({ id: GROUP_A, activeTabId: editor.id, tabOrder: [editor.id] }),
          group({ id: GROUP_B, activeTabId: null, tabOrder: [] })
        ]
      },
      activeGroupIdByWorktree: { [WT]: GROUP_B },
      activeTabType: 'editor',
      activeTabTypeByWorktree: { [WT]: 'editor' }
    })

    expect(resolveWebSessionVisibleTabId(state, WT)).toBeNull()
    expect(resolveWebSessionSiblingVisibleTabId(state, WT)).toBe(editor.id)
  })
})

describe('toVisibleTabType', () => {
  it('collapses every editor-family kind and preserves the rest', () => {
    expect(toVisibleTabType('editor')).toBe('editor')
    expect(toVisibleTabType('diff')).toBe('editor')
    expect(toVisibleTabType('conflict-review')).toBe('editor')
    expect(toVisibleTabType('check-details')).toBe('editor')
    expect(toVisibleTabType('terminal')).toBe('terminal')
    expect(toVisibleTabType('browser')).toBe('browser')
    expect(toVisibleTabType('simulator')).toBe('simulator')
  })
})
