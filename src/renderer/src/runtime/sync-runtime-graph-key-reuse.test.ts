import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildMobileSessionTabSnapshots,
  getRuntimeMobileSessionSyncKey,
  runtimeMobileSessionSyncKeysEqual
} from './sync-runtime-graph'
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

function makeOpenMarkdownFile(): AppState['openFiles'][number] {
  return {
    id: '/repo/README.md',
    filePath: '/repo/README.md',
    relativePath: 'README.md',
    worktreeId: 'wt-1',
    language: 'markdown',
    mode: 'edit',
    isDirty: false
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('runtime mobile session sync key projection reuse', () => {
  it('reuses serialized projections when only runtime pane titles change', () => {
    const base = makeState({
      tabsByWorktree: {
        'wt-1': [{ id: 'term-1', title: 'Codex working', customTitle: null }]
      } as unknown as AppState['tabsByWorktree'],
      runtimePaneTitlesByTabId: {
        'term-1': { 1: 'Codex working' }
      } as unknown as AppState['runtimePaneTitlesByTabId'],
      openFiles: [makeOpenMarkdownFile()],
      editorDrafts: { '/repo/README.md': '# draft' }
    })
    const baseKey = getRuntimeMobileSessionSyncKey(base)
    const titleTick = makeState({
      ...base,
      runtimePaneTitlesByTabId: {
        'term-1': { 1: 'Codex spinner frame' }
      } as unknown as AppState['runtimePaneTitlesByTabId']
    })

    const stringifySpy = vi.spyOn(JSON, 'stringify')
    stringifySpy.mockClear()
    const titleTickKey = getRuntimeMobileSessionSyncKey(titleTick, base, baseKey)

    expect(stringifySpy).not.toHaveBeenCalled()
    expect(titleTickKey.tabsProjection).toBe(baseKey.tabsProjection)
    expect(titleTickKey.openFilesProjection).toBe(baseKey.openFilesProjection)
    expect(titleTickKey.editorDraftsProjection).toBe(baseKey.editorDraftsProjection)
    expect(runtimeMobileSessionSyncKeysEqual(baseKey, titleTickKey)).toBe(false)
  })

  it('only rebuilds the tab projection when a terminal tab title changes', () => {
    const base = makeState({
      tabsByWorktree: {
        'wt-1': [{ id: 'term-1', title: 'Codex working', customTitle: null }]
      } as unknown as AppState['tabsByWorktree'],
      openFiles: [makeOpenMarkdownFile()],
      editorDrafts: { '/repo/README.md': '# draft' }
    })
    const baseKey = getRuntimeMobileSessionSyncKey(base)
    const titleTick = makeState({
      ...base,
      tabsByWorktree: {
        'wt-1': [{ id: 'term-1', title: 'Codex spinner frame', customTitle: null }]
      } as unknown as AppState['tabsByWorktree']
    })

    const stringifySpy = vi.spyOn(JSON, 'stringify')
    stringifySpy.mockClear()
    const titleTickKey = getRuntimeMobileSessionSyncKey(titleTick, base, baseKey)

    expect(stringifySpy).toHaveBeenCalledTimes(1)
    expect(titleTickKey.tabsProjection).not.toBe(baseKey.tabsProjection)
    expect(titleTickKey.openFilesProjection).toBe(baseKey.openFilesProjection)
    expect(titleTickKey.editorDraftsProjection).toBe(baseKey.editorDraftsProjection)
    expect(runtimeMobileSessionSyncKeysEqual(baseKey, titleTickKey)).toBe(false)
  })

  it('does not rebuild serialized projections when only activeTabId changes', () => {
    const base = makeState({
      tabsByWorktree: {
        'wt-1': [{ id: 'term-1', title: 'Codex working', customTitle: null }]
      } as unknown as AppState['tabsByWorktree']
    })
    const baseKey = getRuntimeMobileSessionSyncKey(base)
    const activated = makeState({
      ...base,
      activeTabId: 'term-1'
    })

    const stringifySpy = vi.spyOn(JSON, 'stringify')
    stringifySpy.mockClear()
    const activatedKey = getRuntimeMobileSessionSyncKey(activated, base, baseKey)

    expect(stringifySpy).not.toHaveBeenCalled()
    expect(activatedKey.tabsProjection).toBe(baseKey.tabsProjection)
    expect(activatedKey.openFilesProjection).toBe(baseKey.openFilesProjection)
    expect(activatedKey.editorDraftsProjection).toBe(baseKey.editorDraftsProjection)
    expect(runtimeMobileSessionSyncKeysEqual(baseKey, activatedKey)).toBe(false)
  })

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
  it('reuses draft document versions when only runtime pane titles change', () => {
    const draft = {
      length: 1,
      charCodeAt: vi.fn(() => 120)
    } as unknown as string
    const draftSpy = (draft as unknown as { charCodeAt: ReturnType<typeof vi.fn> }).charCodeAt
    const base = makeState({
      tabsByWorktree: {
        'wt-1': [{ id: 'term-1', title: 'Codex working', customTitle: null }]
      } as unknown as AppState['tabsByWorktree'],
      tabBarOrderByWorktree: { 'wt-1': ['term-1', '/repo/README.md'] },
      runtimePaneTitlesByTabId: {
        'term-1': { 1: 'Codex working' }
      } as unknown as AppState['runtimePaneTitlesByTabId'],
      openFiles: [makeOpenMarkdownFile()],
      editorDrafts: { '/repo/README.md': draft },
      activeFileId: '/repo/README.md'
    })

    buildMobileSessionTabSnapshots(base)
    expect(draftSpy).toHaveBeenCalled()
    draftSpy.mockClear()

    buildMobileSessionTabSnapshots({
      ...base,
      runtimePaneTitlesByTabId: {
        'term-1': { 1: 'Codex spinner frame' }
      } as unknown as AppState['runtimePaneTitlesByTabId']
    })

    expect(draftSpy).not.toHaveBeenCalled()
  })

  it('keeps (publicationEpoch, snapshotVersion) stable for byte-identical worktree content', () => {
    const state = makeState({
      tabsByWorktree: {
        'wt-stable': [{ id: 'term-1', title: 'Codex working', customTitle: null }]
      } as unknown as AppState['tabsByWorktree'],
      terminalLayoutsByTabId: {
        'term-1': {
          root: { type: 'leaf', leafId: '11111111-1111-4111-8111-111111111111' },
          activeLeafId: '11111111-1111-4111-8111-111111111111',
          expandedLeafId: null
        }
      } as unknown as AppState['terminalLayoutsByTabId']
    })

    const first = buildMobileSessionTabSnapshots(state)[0]
    const second = buildMobileSessionTabSnapshots(state)[0]

    // Why: main gates per-worktree mobile fanout on this pair; a no-op rebuild
    // must not mint a fresh version or every graph sync fans out every worktree.
    expect(second?.publicationEpoch).toBe(first?.publicationEpoch)
    expect(second?.snapshotVersion).toBe(first?.snapshotVersion)
  })

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
