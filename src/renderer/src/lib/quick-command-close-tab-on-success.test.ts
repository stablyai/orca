// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { dispatchTerminalCommandFinishedEvent } from '@/hooks/terminal-command-finished-event'
import { closeQuickCommandTabOnSuccess } from './quick-command-close-tab-on-success'

const leaf = (leafId: string) => ({ type: 'leaf', leafId })
const posixInspection = (foregroundPgid: number) => ({
  foregroundProcess: 'zsh',
  hasChildProcesses: false,
  foregroundProcessEvidence: {
    verdict: 'live',
    processName: 'zsh',
    fence: { platform: 'posix', shellPid: 100, shellStartTime: 't', tty: 'ttys001', foregroundPgid }
  }
})
const SHELL_IDLE = posixInspection(100)
const NESTED_SHELL = posixInspection(200)

const mocks = vi.hoisted(() => ({ inspect: vi.fn() }))
vi.mock('@/runtime/hosted-terminals/inspection/runtime-terminal-process-inspection', () => ({
  inspectRuntimeTerminalProcess: mocks.inspect
}))

const mockState: {
  closeTab: ReturnType<typeof vi.fn>
  tabsByWorktree: Record<string, { id: string }[]>
  ptyIdsByTabId: Record<string, string[]>
  terminalLayoutsByTabId: Record<string, { root: unknown }>
} = {
  closeTab: vi.fn(),
  tabsByWorktree: {},
  ptyIdsByTabId: {},
  terminalLayoutsByTabId: {}
}

vi.mock('@/store', () => ({
  useAppStore: { getState: () => mockState }
}))

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

async function finish(exitCode: number | null): Promise<void> {
  dispatchTerminalCommandFinishedEvent('wt', exitCode, 'tab-1')
  await flush()
}

describe('closeQuickCommandTabOnSuccess', () => {
  beforeEach(() => {
    mockState.closeTab.mockReset()
    mocks.inspect.mockReset()
    mockState.tabsByWorktree = { wt: [{ id: 'tab-1' }, { id: 'tab-2' }] }
    mockState.ptyIdsByTabId = { 'tab-1': ['pty-1'], 'tab-2': ['pty-2'] }
    mockState.terminalLayoutsByTabId = {}
  })

  it('closes on exit 0 once the root shell is idle, and only once', async () => {
    mocks.inspect.mockResolvedValue(SHELL_IDLE)
    closeQuickCommandTabOnSuccess('tab-1', 'wt')
    dispatchTerminalCommandFinishedEvent('wt', 0, 'tab-2')
    await flush()
    expect(mocks.inspect).not.toHaveBeenCalled()

    await finish(0)
    expect(mockState.closeTab).toHaveBeenCalledWith('tab-1', { recordInteraction: false })

    mockState.closeTab.mockReset()
    mocks.inspect.mockClear()
    await finish(0)
    expect(mocks.inspect).not.toHaveBeenCalled()
    expect(mockState.closeTab).not.toHaveBeenCalled()
  })

  it('ignores completions while a nested shell or command still owns the terminal', async () => {
    closeQuickCommandTabOnSuccess('tab-1', 'wt')
    mocks.inspect.mockResolvedValue(NESTED_SHELL)
    await finish(0)
    await finish(1)
    expect(mockState.closeTab).not.toHaveBeenCalled()

    mocks.inspect.mockResolvedValue(SHELL_IDLE)
    await finish(0)
    expect(mockState.closeTab).toHaveBeenCalledWith('tab-1', { recordInteraction: false })
  })

  it('keeps the tab open on failure, unknown exit, unverifiable inspection, or a split', async () => {
    mocks.inspect.mockResolvedValue(SHELL_IDLE)
    closeQuickCommandTabOnSuccess('tab-1', 'wt')
    await finish(1)
    await finish(0)

    closeQuickCommandTabOnSuccess('tab-1', 'wt')
    await finish(null)

    mocks.inspect.mockResolvedValue({
      foregroundProcess: null,
      hasChildProcesses: false,
      verdict: 'unverifiable',
      reason: 'timeout'
    })
    closeQuickCommandTabOnSuccess('tab-1', 'wt')
    await finish(0)

    mockState.terminalLayoutsByTabId['tab-1'] = {
      root: { type: 'split', first: leaf('a'), second: leaf('b') }
    }
    mocks.inspect.mockResolvedValue(SHELL_IDLE)
    closeQuickCommandTabOnSuccess('tab-1', 'wt')
    await finish(0)

    expect(mockState.closeTab).not.toHaveBeenCalled()
  })
})
