import { vi, type Mock } from 'vitest'

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
  worktreesByRepo: Record<string, { id: string; path: string }[]>
}

export type TerminalLinkTestDoubles = {
  openUrlMock: Mock
  openFileUriMock: Mock
  openFilePathMock: Mock
  openFileMock: Mock
  authorizeExternalPathMock: Mock
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
  const authorizeExternalPathMock = vi.fn()
  const statMock = vi.fn().mockResolvedValue({ isDirectory: false })
  const fsPathExistsMock = vi.fn().mockResolvedValue(true)
  const runtimeEnvironmentCallMock = vi.fn()
  const runtimeEnvironmentTransportCallMock = vi.fn()
  const setActiveWorktreeMock = vi.fn()
  const createBrowserTabMock = vi.fn()
  const setPendingEditorRevealMock = vi.fn()
  const setMarkdownViewModeMock = vi.fn()

  const deps = { worktreeId: 'wt-1', worktreePath: '/tmp' }
  const storeState = {
    settings: undefined as TerminalLinkStoreSettings | undefined,
    setActiveWorktree: setActiveWorktreeMock,
    createBrowserTab: createBrowserTabMock,
    openFile: openFileMock,
    setPendingEditorReveal: setPendingEditorRevealMock,
    setMarkdownViewMode: setMarkdownViewModeMock,
    activeFileIdByWorktree: {} as Record<string, string | null>,
    worktreesByRepo: {} as Record<string, { id: string; path: string }[]>
  }

  return {
    openUrlMock,
    openFileUriMock,
    openFilePathMock,
    openFileMock,
    authorizeExternalPathMock,
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
