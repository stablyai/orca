import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const toastError = vi.fn()
vi.mock('sonner', () => ({ toast: { error: (...args: unknown[]) => toastError(...args) } }))
const activate = vi.fn()
vi.mock('@/lib/workspace/activation/worktree-activation', () => ({
  activateAndRevealWorktree: (id: string) => activate(id)
}))

const { useAppStore } = await import('@/store')
const { makePaneKey } = await import('../../../../shared/workspace-layout/stable-pane-id')
const attempts = await import('./cloud-agent-restart-attempt')
const { restartPaneExists, watchCloudAgentRestartPane } =
  await import('./cloud-agent-restart-pane-watch')

const TAB = 'tab-1'
const LEAF = '11111111-1111-4111-8111-111111111111'
const PANE = makePaneKey(TAB, LEAF)
const PTY = 'remote:env-1@@term_a'

function seed(): void {
  useAppStore.setState({
    tabsByWorktree: {
      'wt-1': [
        {
          id: TAB,
          ptyId: PTY,
          worktreeId: 'wt-1',
          title: 'claude',
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: 1
        }
      ]
    },
    terminalLayoutsByTabId: {
      [TAB]: {
        root: { type: 'leaf', leafId: LEAF },
        activeLeafId: LEAF,
        expandedLeafId: null,
        ptyIdsByLeafId: { [LEAF]: PTY }
      }
    }
  })
}

describe('RA-11 Restart when its pane goes away', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    toastError.mockClear()
    activate.mockClear()
    attempts.resetCloudAgentRestartsForTest()
    seed()
    attempts.beginCloudAgentRestart(
      PANE,
      { agent: 'claude', resumable: true, ptyId: PTY },
      () => undefined
    )
  })
  afterEach(() => {
    attempts.resetCloudAgentRestartsForTest()
    vi.useRealTimers()
  })

  it('a restart rebinding the leaf’s PTY keeps the pane: same tab, same leaf, no toast', () => {
    watchCloudAgentRestartPane(PANE, 'wt-1', 'claude')
    useAppStore.setState({
      terminalLayoutsByTabId: {
        [TAB]: {
          root: { type: 'leaf', leafId: LEAF },
          activeLeafId: LEAF,
          expandedLeafId: null,
          ptyIdsByLeafId: {}
        }
      }
    })
    expect(restartPaneExists(useAppStore.getState(), PANE)).toBe(true)
    expect(toastError).not.toHaveBeenCalled()
    expect(attempts.cloudAgentRestartAttempt(PANE, 0)?.phase).toBe('restarting')
  })

  it('the tab closing mid-restart ends the attempt with a toast naming the workspace', () => {
    watchCloudAgentRestartPane(PANE, 'wt-1', 'claude')
    useAppStore.setState({ tabsByWorktree: { 'wt-1': [] }, terminalLayoutsByTabId: {} })
    expect(attempts.cloudAgentRestartAttempt(PANE, 0)).toBeNull()
    expect(toastError).toHaveBeenCalledTimes(1)
    const [title, options] = toastError.mock.calls[0]
    expect(title).toBe('Couldn’t restart Claude in wt-1.')
    options.action.onClick()
    expect(activate).toHaveBeenCalledWith('wt-1')
  })

  it('stops watching once the attempt settled', () => {
    const stop = watchCloudAgentRestartPane(PANE, 'wt-1', 'claude')
    attempts.dismissCloudAgentRestart(PANE)
    useAppStore.setState({ tabsByWorktree: { 'wt-1': [] } })
    expect(toastError).not.toHaveBeenCalled()
    stop()
  })
})
