import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { stubHeadlessReact } from '../tab-bar/tab-bar-windows-shell-launch-render-stubs'

const mocks = vi.hoisted(() => ({
  createTab: vi.fn(),
  setActiveTab: vi.fn(),
  setActiveTabType: vi.fn(),
  setActiveWorktree: vi.fn(),
  focusGroup: vi.fn(),
  createBrowserTab: vi.fn(),
  createEmptySplitGroup: vi.fn(),
  openNewBrowserTabInActiveWorkspace: vi.fn(),
  openNewMarkdownInActiveWorkspace: vi.fn(),
  openNewTerminalTabInActiveWorkspace: vi.fn(),
  getRuntimeEnvironmentIdForWorktree: vi.fn(),
  focusTerminalTabSurface: vi.fn(),
  runtimeCall: vi.fn()
}))

vi.mock('react', async () => await stubHeadlessReact())

vi.mock('@/lib/worktree-runtime-owner', () => ({
  getRuntimeEnvironmentIdForWorktree: mocks.getRuntimeEnvironmentIdForWorktree,
  getRuntimeSessionMirrorEnvironmentIds: () => []
}))

vi.mock('../../lib/focus-terminal-tab-surface', () => ({
  focusTerminalTabSurface: mocks.focusTerminalTabSurface
}))

const WORKTREE_ID = 'repo::C:/Users/neil/orca/workspaces/orca/aug23-triage'
const GROUP_ID = 'group-1'
const FOCUSED_ENVIRONMENT_ID = 'arch-dev'

const storeState = {
  settings: { activeRuntimeEnvironmentId: FOCUSED_ENVIRONMENT_ID },
  activeWorktreeId: WORKTREE_ID,
  activeWorkspaceExecutionHostId: 'local' as string | null,
  browserTabsByWorktree: {},
  browserPagesByWorkspace: {},
  remoteBrowserPageHandlesByPageId: {},
  createTab: mocks.createTab,
  setActiveTab: mocks.setActiveTab,
  setActiveTabType: mocks.setActiveTabType,
  setActiveWorktree: mocks.setActiveWorktree,
  focusGroup: mocks.focusGroup,
  createBrowserTab: mocks.createBrowserTab,
  createEmptySplitGroup: mocks.createEmptySplitGroup,
  openNewBrowserTabInActiveWorkspace: mocks.openNewBrowserTabInActiveWorkspace,
  openNewMarkdownInActiveWorkspace: mocks.openNewMarkdownInActiveWorkspace,
  openNewTerminalTabInActiveWorkspace: mocks.openNewTerminalTabInActiveWorkspace
}

const useAppStore = Object.assign(
  (selector?: (state: typeof storeState) => unknown) =>
    selector ? selector(storeState) : storeState,
  {
    getState: () => storeState,
    setState: vi.fn(),
    subscribe: vi.fn()
  }
)

vi.mock('../../store', () => ({ useAppStore }))

/**
 * The "+" menu's shell rows on a workspace that no runtime environment owns. The remote
 * runtime is connected and focused, which is the whole trap: an unowned workspace must
 * still open its shell locally instead of asking that runtime to resolve a selector it
 * has never heard of (#16444).
 */
describe('tab group "+" menu shell launch on a locally-owned workspace', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    storeState.activeWorkspaceExecutionHostId = 'local'
    mocks.getRuntimeEnvironmentIdForWorktree.mockReturnValue(null)
    mocks.createTab.mockReturnValue({ id: 'local-tab-1' })
    vi.stubGlobal('window', { api: { runtimeEnvironments: { call: mocks.runtimeCall } } })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('opens the shell locally without consulting the focused runtime environment', async () => {
    const { useTabGroupCreationCommands } = await import('./useTabGroupCreationCommands')
    const commands = useTabGroupCreationCommands({
      groupId: GROUP_ID,
      worktreeId: WORKTREE_ID,
      worktreeState: { mobileEmulatorEnabled: false } as never
    })

    commands.newTerminalWithShell('powershell.exe')
    await vi.waitFor(() => expect(mocks.createTab).toHaveBeenCalled())

    expect(mocks.runtimeCall).not.toHaveBeenCalled()
    expect(mocks.createTab).toHaveBeenCalledWith(WORKTREE_ID, GROUP_ID, 'powershell.exe')
    expect(mocks.setActiveTab).toHaveBeenCalledWith('local-tab-1')
  })

  it('leaves the workspace on its own execution host', async () => {
    const { useTabGroupCreationCommands } = await import('./useTabGroupCreationCommands')
    const commands = useTabGroupCreationCommands({
      groupId: GROUP_ID,
      worktreeId: WORKTREE_ID,
      worktreeState: { mobileEmulatorEnabled: false } as never
    })

    commands.newTerminalWithShell('powershell.exe')
    await vi.waitFor(() => expect(mocks.createTab).toHaveBeenCalled())

    // Latching the workspace onto the focused runtime is what silently broke the next Ctrl+T.
    expect(mocks.setActiveWorktree).not.toHaveBeenCalled()
    expect(storeState.activeWorkspaceExecutionHostId).toBe('local')
  })
})
