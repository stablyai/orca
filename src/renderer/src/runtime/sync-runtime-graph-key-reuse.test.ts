import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildMobileSessionTabSnapshots } from './sync-runtime-graph/mobile-session-snapshots'
import {
  getRuntimeMobileSessionSyncKey,
  runtimeMobileSessionSyncKeysEqual
} from './sync-runtime-graph/sync-key'
import type { AppState } from '../store/types'

function makeState(overrides: Partial<AppState> = {}): AppState {
  return {
    tabsByWorktree: {},
    terminalLayoutsByTabId: {} as AppState['terminalLayoutsByTabId'],
    runtimePaneTitlesByTabId: {} as AppState['runtimePaneTitlesByTabId'],
    groupsByWorktree: {},
    activeGroupIdByWorktree: {},
    unifiedTabsByWorktree: {},
    tabBarOrderByWorktree: {},
    activeFileId: null,
    activeFileIdByWorktree: {},
    openFiles: [],
    editorDrafts: {},
    activeTabId: null,
    ...overrides
  } as AppState
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('runtime mobile session sync key projection reuse', () => {
  it('reuses unchanged worktree tab projections when one worktree title changes', () => {
    const unchangedTitle = vi.fn(() => 'Unchanged agent')
    const unchangedTab = {
      id: 'term-unchanged',
      customTitle: null,
      get title() {
        return unchangedTitle()
      }
    }
    const base = makeState({
      tabsByWorktree: {
        'wt-1': [{ id: 'term-1', title: 'Codex working', customTitle: null }],
        'wt-2': [unchangedTab]
      } as unknown as AppState['tabsByWorktree']
    })
    const baseKey = getRuntimeMobileSessionSyncKey(base)
    expect(unchangedTitle).toHaveBeenCalled()
    unchangedTitle.mockClear()

    const titleTick = makeState({
      ...base,
      tabsByWorktree: {
        ...base.tabsByWorktree,
        'wt-1': [{ id: 'term-1', title: 'Codex spinner frame', customTitle: null }]
      } as unknown as AppState['tabsByWorktree']
    })

    const titleTickKey = getRuntimeMobileSessionSyncKey(titleTick, base, baseKey)

    expect(unchangedTitle).not.toHaveBeenCalled()
    expect(titleTickKey.tabsProjection).not.toBe(baseKey.tabsProjection)
    expect(runtimeMobileSessionSyncKeysEqual(baseKey, titleTickKey)).toBe(false)
  })
})

describe('mobile session snapshot reuse', () => {
  it('bumps only the changed worktree version when a sibling stays byte-identical', () => {
    const makeTwoWorktreeState = (title: string): AppState =>
      makeState({
        tabsByWorktree: {
          'wt-changed': [{ id: 'term-a', title, customTitle: null }],
          'wt-stable-sibling': [{ id: 'term-b', title: 'Idle agent', customTitle: null }]
        } as unknown as AppState['tabsByWorktree'],
        terminalLayoutsByTabId: {
          'term-a': {
            root: { type: 'leaf', leafId: '22222222-2222-4222-8222-222222222222' },
            activeLeafId: '22222222-2222-4222-8222-222222222222',
            expandedLeafId: null
          },
          'term-b': {
            root: { type: 'leaf', leafId: '33333333-3333-4333-8333-333333333333' },
            activeLeafId: '33333333-3333-4333-8333-333333333333',
            expandedLeafId: null
          }
        } as unknown as AppState['terminalLayoutsByTabId']
      })

    const before = new Map(
      buildMobileSessionTabSnapshots(makeTwoWorktreeState('Codex working')).map((snapshot) => [
        snapshot.worktree,
        snapshot
      ])
    )
    const after = new Map(
      buildMobileSessionTabSnapshots(makeTwoWorktreeState('Codex done')).map((snapshot) => [
        snapshot.worktree,
        snapshot
      ])
    )

    expect(after.get('wt-changed')?.snapshotVersion).toBeGreaterThan(
      before.get('wt-changed')?.snapshotVersion ?? Number.POSITIVE_INFINITY
    )
    expect(after.get('wt-stable-sibling')?.snapshotVersion).toBe(
      before.get('wt-stable-sibling')?.snapshotVersion
    )
  })
})
