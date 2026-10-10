import { vi, type Mock } from 'vitest'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { TabGroup, TabGroupLayoutNode } from '../../../../shared/tab-types'


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
  setPendingEditorReveal: Mock
  setMarkdownViewMode: Mock
  activeFileIdByWorktree: Record<string, string | null>
  openFiles: { filePath: string; worktreeId: string }[]
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
  layoutByWorktree: Record<string, TabGroupLayoutNode | undefined>
  activeGroupIdByWorktree: Record<string, string | undefined>
  groupsByWorktree: Record<string, TabGroup[]>
  createEmptySplitGroup: Mock
}

export type TerminalLinkTestDoubles = {
  openUrlMock: Mock
  openFileUriMock: Mock
  openFilePathMock: Mock
  openFileMock: Mock
  statMock: Mock
  fsPathExistsMock: Mock
  runtimeEnvironmentCallMock: Mock
  runtimeEnvironmentTransportCallMock: Mock
  setActiveWorktreeMock: Mock
  createBrowserTabMock: Mock
  setPendingEditorRevealMock: Mock
  setMarkdownViewModeMock: Mock
  createEmptySplitGroupMock: Mock
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
  const createEmptySplitGroupMock = vi.fn(() => 'g2')

  const deps = { worktreeId: 'wt-1', worktreePath: '/tmp' }
  const storeState: TerminalLinkStoreState = {
    settings: undefined as TerminalLinkStoreSettings | undefined,
    setActiveWorktree: setActiveWorktreeMock,
    createBrowserTab: createBrowserTabMock,
    openFile: openFileMock,
    setPendingEditorReveal: setPendingEditorRevealMock,
    setMarkdownViewMode: setMarkdownViewModeMock,
    activeFileIdByWorktree: {} as Record<string, string | null>,
    openFiles: [] as { filePath: string; worktreeId: string }[],
    worktreesByRepo: {},
    folderWorkspaces: [],
    layoutByWorktree: {},
    activeGroupIdByWorktree: {},
    groupsByWorktree: {},
    createEmptySplitGroup: createEmptySplitGroupMock
  }

  return {
    openUrlMock,
    openFileUriMock,
    openFilePathMock,
    openFileMock,
    statMock,
    fsPathExistsMock,
    runtimeEnvironmentCallMock,
    runtimeEnvironmentTransportCallMock,
    setActiveWorktreeMock,
    createBrowserTabMock,
    setPendingEditorRevealMock,
    setMarkdownViewModeMock,
    createEmptySplitGroupMock,
    deps,
    storeState
  }
}
