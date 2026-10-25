import { vi, type Mock } from 'vitest'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { Tab, TabGroup } from '../../../../shared/tab-types'

export type TerminalLinkStoreSettings = {
  openLinksInApp?: boolean
  openLinksInAppPreferencePrompted?: boolean
  activeRuntimeEnvironmentId?: string | null
}

export type TerminalLinkStoreState = {
  settings: TerminalLinkStoreSettings | undefined
  setActiveWorktree: Mock
  createBrowserTab: Mock
  openFile: Mock
  openFileForLink: Mock
  setPendingEditorReveal: Mock
  setMarkdownViewMode: Mock
  activeFileIdByWorktree: Record<string, string | null>
  openFiles: { filePath: string; worktreeId: string }[]
  groupsByWorktree: Record<string, TabGroup[]>
  unifiedTabsByWorktree: Record<
    string,
    (Pick<Tab, 'id' | 'entityId' | 'groupId'> &
      Partial<Pick<Tab, 'contentType' | 'executionHostId'>>)[]
  >
  worktreesByRepo: Record<
    string,
    {
      id: string
      path: string
      repoId?: string
      hostId?: ExecutionHostId
      runtimeOwnerEnvironmentId?: string
    }[]
  >
  folderWorkspaces: []
}

export type TerminalLinkTestDoubles = {
  openUrlMock: Mock
  openFileUriMock: Mock
  openFilePathMock: Mock
  openFileMock: Mock
  openFileForLinkMock: Mock
  statMock: Mock
  fsPathExistsMock: Mock
  runtimeEnvironmentCallMock: Mock
  runtimeEnvironmentTransportCallMock: Mock
  setActiveWorktreeMock: Mock
  createBrowserTabMock: Mock
  setPendingEditorRevealMock: Mock
  setMarkdownViewModeMock: Mock
  deps: { worktreeId: string; worktreePath: string }
  storeState: TerminalLinkStoreState
}

/** Store/IPC doubles the terminal link-routing specs assert against. */
export function createTerminalLinkTestDoubles(): TerminalLinkTestDoubles {
  const openUrlMock = vi.fn()
  const openFileUriMock = vi.fn()
  const openFilePathMock = vi.fn()
  const openFileMock = vi.fn()
  const statMock = vi.fn().mockResolvedValue({ isDirectory: false })
  const fsPathExistsMock = vi.fn().mockResolvedValue(true)
  const runtimeEnvironmentCallMock = vi.fn()
  const runtimeEnvironmentTransportCallMock = vi.fn()
  const setActiveWorktreeMock = vi.fn()
  const createBrowserTabMock = vi.fn()
  const setPendingEditorRevealMock = vi.fn()
  const setMarkdownViewModeMock = vi.fn()

  const deps = { worktreeId: 'wt-1', worktreePath: '/tmp' }
  // Why: specs assert the legacy openFile(file, options) shape; the link entry point delegates to it
  // and records the view it "opened" so the guarded reveal can find it.
  const openFileForLinkMock = vi.fn(
    (
      file: { filePath: string; worktreeId: string },
      options: unknown,
      _intent: unknown,
      onShown?: (shown: { fileId: string; viewStateId: string; groupId: string }) => void
    ) => {
      const returned: unknown = openFileMock(file, options)
      const fileId =
        typeof returned === 'string'
          ? returned
          : (storeState.activeFileIdByWorktree[file.worktreeId] ?? file.filePath)
      const view = { id: `view:${fileId}`, entityId: fileId, groupId: 'group-1' }
      storeState.unifiedTabsByWorktree = {
        ...storeState.unifiedTabsByWorktree,
        [file.worktreeId]: [...(storeState.unifiedTabsByWorktree[file.worktreeId] ?? []), view]
      }
      const shown = { fileId, viewStateId: view.id, groupId: view.groupId }
      // As today's store: the view is drawn at once.
      onShown?.(shown)
      return shown
    }
  )
  const storeState: TerminalLinkStoreState = {
    settings: undefined as TerminalLinkStoreSettings | undefined,
    setActiveWorktree: setActiveWorktreeMock,
    createBrowserTab: createBrowserTabMock,
    openFile: openFileMock,
    openFileForLink: openFileForLinkMock,
    setPendingEditorReveal: setPendingEditorRevealMock,
    setMarkdownViewMode: setMarkdownViewModeMock,
    activeFileIdByWorktree: {} as Record<string, string | null>,
    openFiles: [],
    unifiedTabsByWorktree: {},
    groupsByWorktree: {},
    worktreesByRepo: {},
    folderWorkspaces: []
  }

  return {
    openUrlMock,
    openFileUriMock,
    openFilePathMock,
    openFileMock,
    openFileForLinkMock,
    statMock,
    fsPathExistsMock,
    runtimeEnvironmentCallMock,
    runtimeEnvironmentTransportCallMock,
    setActiveWorktreeMock,
    createBrowserTabMock,
    setPendingEditorRevealMock,
    setMarkdownViewModeMock,
    deps,
    storeState
  }
}
