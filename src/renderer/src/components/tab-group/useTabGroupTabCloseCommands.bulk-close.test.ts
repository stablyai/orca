import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Tab } from '../../../../shared/tab-types'

const mocks = vi.hoisted(() => ({
  activateTerminal: vi.fn(),
  closeBrowserTab: vi.fn(),
  closeFile: vi.fn(),
  closeTab: vi.fn(),
  closeTerminalTab: vi.fn(),
  closeUnifiedTab: vi.fn(),
  inspectRuntimeTerminalProcess: vi.fn(),
  setActiveWorktree: vi.fn()
}))

const storeBox = vi.hoisted(() => ({ state: {} as Record<string, unknown> }))

vi.mock('react', async () => {
  const actual = await vi.importActual<typeof import('react')>('react') // eslint-disable-line @typescript-eslint/consistent-type-imports -- vi.importActual requires inline import()
  return { ...actual, useCallback: <T>(callback: T) => callback }
})

vi.mock('../../store', () => {
  const useAppStore = Object.assign(
    (selector: (state: Record<string, unknown>) => unknown) => selector(storeBox.state),
    { getState: () => storeBox.state }
  )
  return { useAppStore }
})

vi.mock('@/runtime/runtime-terminal-inspection', () => ({
  inspectRuntimeTerminalProcess: mocks.inspectRuntimeTerminalProcess
}))

vi.mock('../../runtime/web-runtime-session', () => ({
  closeWebRuntimeSessionTab: vi.fn(),
  isWebRuntimeSessionActive: () => false
}))

vi.mock('../../store/slices/browser-webview-cleanup', () => ({
  destroyWorkspaceWebviews: vi.fn()
}))

vi.mock('../editor/editor-autosave', () => ({ requestEditorFileClose: vi.fn() }))

vi.mock('@/lib/worktree-runtime-owner', () => ({
  getRuntimeEnvironmentIdForWorktree: () => null
}))

vi.mock('@/runtime/remote-browser-tab-ownership', () => ({
  browserWorkspaceHasRemoteOwner: () => false
}))

vi.mock('../terminal/terminal-tab-actions', () => ({ closeTerminalTab: mocks.closeTerminalTab }))

import { useRunningTerminalCloseConfirmStore } from '@/store/running-terminal-close-confirm'
import { useTabGroupTabCloseCommands } from './useTabGroupTabCloseCommands'

const GROUP_TABS = [
  { id: 'unified-a', entityId: 'tab-a', contentType: 'terminal', label: 'npm run dev' },
  { id: 'unified-b', entityId: 'tab-b', contentType: 'terminal', label: 'pytest' }
] as unknown as Tab[]

// Why: `useCallback` is stubbed to identity above, so the hook is a plain factory here.
function visibleRequest() {
  return useRunningTerminalCloseConfirmStore.getState().runningTerminalCloseConfirm
}

function useCloseCommands() {
  return useTabGroupTabCloseCommands({
    worktreeId: 'wt-1',
    groupTabs: GROUP_TABS,
    revealTerminal: mocks.activateTerminal
  })
}

async function settleProbe(): Promise<void> {
  for (let tick = 0; tick < 12; tick += 1) {
    await Promise.resolve()
  }
}

/** Monotonic per-test clock; the confirm store's stray-action guard is module state keyed
 *  to Date.now(), so each test needs a clock ahead of whatever the previous one armed. */
let testClock = Date.UTC(2026, 0, 1)

describe('useTabGroupTabCloseCommands closeMany', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    testClock += 60 * 60 * 1000
    vi.setSystemTime(testClock)
    storeBox.state = {
      settings: {},
      ptyIdsByTabId: { 'tab-a': ['pty-a'], 'tab-b': ['pty-b'] },
      terminalLayoutsByTabId: {},
      unifiedTabsByWorktree: { 'wt-1': GROUP_TABS },
      tabsByWorktree: { 'wt-1': [{ id: 'tab-a' }, { id: 'tab-b' }] },
      openFiles: [],
      browserPagesByWorkspace: {},
      agentStatusByPaneKey: {},
      activeWorktreeId: 'wt-1',
      closeUnifiedTab: mocks.closeUnifiedTab,
      closeTab: mocks.closeTab,
      closeFile: mocks.closeFile,
      closeBrowserTab: mocks.closeBrowserTab,
      setActiveWorktree: mocks.setActiveWorktree,
      reconcileWorktreeTabModel: () => ({ renderableTabCount: 1 })
    }
    useRunningTerminalCloseConfirmStore.getState().confirmAllRunningTerminalCloses()
    useRunningTerminalCloseConfirmStore.setState({ runningTerminalCloseConfirm: null })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('closes straight through when no tab in the set is busy', async () => {
    mocks.inspectRuntimeTerminalProcess.mockResolvedValue({
      hasChildProcesses: false,
      unavailable: false
    })

    useCloseCommands().closeMany(['unified-a', 'unified-b'])
    await settleProbe()

    expect(mocks.closeTab).toHaveBeenCalledTimes(2)
    expect(useRunningTerminalCloseConfirmStore.getState().runningTerminalCloseConfirm).toBeNull()
  })

  it('asks about each busy tab in turn, jumping to it, and closes only after the last answer', async () => {
    mocks.inspectRuntimeTerminalProcess.mockResolvedValue({
      hasChildProcesses: true,
      unavailable: false
    })

    useCloseCommands().closeMany(['unified-a', 'unified-b'])
    await settleProbe()

    expect(mocks.closeTab).not.toHaveBeenCalled()
    expect(mocks.activateTerminal).toHaveBeenLastCalledWith('tab-a')
    expect(visibleRequest()?.tabLabel).toBe('npm run dev')

    useRunningTerminalCloseConfirmStore.getState().confirmRunningTerminalClose()

    expect(mocks.closeTab).not.toHaveBeenCalled()
    expect(mocks.activateTerminal).toHaveBeenLastCalledWith('tab-b')
    expect(visibleRequest()?.tabLabel).toBe('pytest')

    vi.advanceTimersByTime(400)
    useRunningTerminalCloseConfirmStore.getState().confirmRunningTerminalClose()

    expect(mocks.closeTab).toHaveBeenCalledTimes(2)
  })

  it('closes nothing when any prompt in the run is cancelled', async () => {
    mocks.inspectRuntimeTerminalProcess.mockResolvedValue({
      hasChildProcesses: true,
      unavailable: false
    })

    useCloseCommands().closeMany(['unified-a', 'unified-b'])
    await settleProbe()
    useRunningTerminalCloseConfirmStore.getState().confirmRunningTerminalClose()
    vi.advanceTimersByTime(400)
    useRunningTerminalCloseConfirmStore.getState().dismissRunningTerminalClose()

    expect(mocks.closeTab).not.toHaveBeenCalled()
  })
})
