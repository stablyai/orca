// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { activateAndRevealWorkspace } from '@/lib/worktree-activation'
import { openHttpLink, registerHttpLinkStoreAccessor } from '@/lib/http-link-routing'
import { FLOATING_TERMINAL_WORKTREE_ID, getDefaultSettings } from '../../../../shared/constants'
import { openDetectedFilePath } from './terminal-file-open-routing'
import { buildFileLinkActions, handleTerminalFileLink } from './terminal-file-link-actions'

const mocks = vi.hoisted(() => ({
  stat: vi.fn(),
  findWorkspaceFileRoute: vi.fn()
}))

vi.mock('@/lib/user-opened-local-path', () => ({ statUserOpenedPath: mocks.stat }))
vi.mock('@/lib/runtime-workspace-file-route', () => ({
  findWorkspaceFileRoute: mocks.findWorkspaceFileRoute
}))

const initialState = useAppStore.getState()
const deps = {
  worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
  worktreePath: '/Users/me/floating',
  runtimeEnvironmentId: null
}
const createBrowserTab = vi.fn()
const openFile = vi.fn()
const markWorktreeVisited = vi.fn()
const recordWorktreeVisit = vi.fn()
const revealWorktreeInSidebar = vi.fn()

function mainSelection(): object {
  const state = useAppStore.getState()
  return {
    repo: state.activeRepoId,
    workspace: state.activeWorktreeId,
    host: state.activeWorkspaceExecutionHostId,
    view: state.activeView,
    tabType: state.activeTabType,
    tab: state.activeTabId,
    file: state.activeFileId,
    browser: state.activeBrowserTabId,
    rightSidebar: state.rightSidebarTab
  }
}

beforeEach(() => {
  vi.stubGlobal('navigator', { userAgent: 'Macintosh' })
  vi.stubGlobal('window', { dispatchEvent: vi.fn() })
  vi.clearAllMocks()
  mocks.stat.mockResolvedValue({ isDirectory: false, escapesWorktree: false })
  mocks.findWorkspaceFileRoute.mockReturnValue(null)
  useAppStore.setState({
    settings: {
      ...getDefaultSettings('/tmp'),
      floatingTerminalEnabled: true,
      openLinksInApp: true
    },
    floatingWorkspacePath: deps.worktreePath,
    floatingWorkspacePanelOpen: true,
    activeRepoId: 'main-repo',
    activeWorktreeId: 'main-workspace',
    activeWorkspaceExecutionHostId: null,
    activeView: 'terminal',
    activeTabType: 'terminal',
    activeTabId: 'main-chat',
    activeFileId: 'main-file',
    activeBrowserTabId: 'main-browser',
    rightSidebarTab: 'explorer',
    createBrowserTab,
    openFile,
    markWorktreeVisited,
    recordWorktreeVisit,
    revealWorktreeInSidebar
  })
  registerHttpLinkStoreAccessor(() => useAppStore.getState())
})

afterEach(() => {
  useAppStore.setState(initialState, true)
  vi.unstubAllGlobals()
})

async function flushOpen(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('floating file links preserve main-window selection', () => {
  it.each([
    ['git', 'main-workspace', null],
    ['folder', 'folder:main-folder', null],
    ['SSH', 'main-workspace', 'ssh:main-host']
  ] as const)('opens HTML beside an active %s workspace', async (_kind, workspace, host) => {
    useAppStore.setState({ activeWorktreeId: workspace, activeWorkspaceExecutionHostId: host })
    const before = mainSelection()

    handleTerminalFileLink(
      '/Users/me/report.html',
      null,
      null,
      new MouseEvent('click', {
        metaKey: true
      }),
      deps
    )
    await flushOpen()

    expect(createBrowserTab).toHaveBeenCalledWith(
      FLOATING_TERMINAL_WORKTREE_ID,
      'file:///Users/me/report.html',
      { title: 'report.html', activate: true }
    )
    expect(mainSelection()).toEqual(before)
    expect(markWorktreeVisited).not.toHaveBeenCalled()
    expect(recordWorktreeVisit).not.toHaveBeenCalled()
    expect(revealWorktreeInSidebar).not.toHaveBeenCalled()
  })

  it('opens the plain-click file action in the floating editor even when a project has the file open', async () => {
    const filePath = '/project/readme.md'
    useAppStore.setState({
      openFiles: [
        {
          id: filePath,
          filePath,
          relativePath: 'readme.md',
          worktreeId: 'folder:project',
          language: 'markdown',
          mode: 'edit',
          isDirty: false
        }
      ]
    })
    mocks.findWorkspaceFileRoute.mockReturnValue({
      worktreeId: 'folder:project',
      relativePath: 'readme.md',
      executionHostId: 'local'
    })
    const before = mainSelection()

    await buildFileLinkActions(filePath, null, null, deps, { kind: 'local' }).primary.run()
    await flushOpen()

    expect(openFile).toHaveBeenCalledWith(
      expect.objectContaining({ filePath, worktreeId: FLOATING_TERMINAL_WORKTREE_ID }),
      { forceContentReload: true }
    )
    expect(mocks.findWorkspaceFileRoute).not.toHaveBeenCalled()
    expect(mainSelection()).toEqual(before)
  })

  it('opens a source file directly within the floating workspace', async () => {
    const before = mainSelection()
    openDetectedFilePath('/Users/me/floating/app.ts', null, null, deps)
    await flushOpen()
    expect(openFile).toHaveBeenCalledWith(
      expect.objectContaining({ worktreeId: FLOATING_TERMINAL_WORKTREE_ID }),
      { forceContentReload: true }
    )
    expect(mainSelection()).toEqual(before)
  })

  it('reveals a closed floating panel through workspace activation without selecting it in main', () => {
    useAppStore.setState({ floatingWorkspacePanelOpen: false })
    const before = mainSelection()
    expect(activateAndRevealWorkspace(FLOATING_TERMINAL_WORKTREE_ID)).toEqual({
      primaryTabId: null
    })
    expect(window.dispatchEvent).toHaveBeenCalledTimes(1)
    expect(mainSelection()).toEqual(before)
  })

  it('keeps HTTP links in the floating browser as well', () => {
    const before = mainSelection()
    openHttpLink('https://example.com', {
      worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
      sourceOwner: { kind: 'local' }
    })
    expect(createBrowserTab).toHaveBeenCalledWith(
      FLOATING_TERMINAL_WORKTREE_ID,
      'https://example.com',
      { activate: true }
    )
    expect(mainSelection()).toEqual(before)
  })
})
