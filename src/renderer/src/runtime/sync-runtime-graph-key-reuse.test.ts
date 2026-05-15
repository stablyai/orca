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
})
