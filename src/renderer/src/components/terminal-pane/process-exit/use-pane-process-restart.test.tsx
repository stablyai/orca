// @vitest-environment happy-dom
import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { resumeSleepingAgentSessionsForWorktree } from '@/lib/agent-session/resume/resume-sleeping-agent-session'
import { connectPanePty } from '../pty-connection/connect-pane-pty'
import { usePaneProcessRestart } from './use-pane-process-restart'

vi.mock('../pty-connection/connect-pane-pty', () => ({ connectPanePty: vi.fn() }))
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', async (importOriginal) =>
  (
    await import('@/runtime/workspace-layout/testing/layout-apply-test-transport.test-fixture')
  ).runtimeRpcClientWithLayoutApply(await importOriginal())
)

const initialState = useAppStore.getState()
const leafId = '11111111-1111-4111-8111-111111111111'
let releaseRestart: (() => void) | undefined

afterEach(() => {
  releaseRestart?.()
  releaseRestart = undefined
  cleanup()
  useAppStore.setState(initialState, true)
  vi.clearAllMocks()
})

it('keeps the same conversation tab when its workspace opens during a mounted restart', () => {
  useAppStore.setState({
    activeWorktreeId: 'other-worktree',
    tabsByWorktree: {
      worktree: [
        {
          id: 'tab',
          worktreeId: 'worktree',
          ptyId: 'old-pty',
          title: 'Claude',
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: 1
        }
      ]
    },
    ptyIdsByTabId: { tab: ['old-pty'] },
    terminalLayoutsByTabId: {
      tab: {
        root: { type: 'leaf', leafId },
        activeLeafId: leafId,
        expandedLeafId: null,
        ptyIdsByLeafId: { [leafId]: 'old-pty' }
      }
    },
    sleepingAgentSessionsByPaneKey: {
      [`tab:${leafId}`]: {
        paneKey: `tab:${leafId}`,
        tabId: 'tab',
        worktreeId: 'worktree',
        agent: 'claude',
        providerSession: { key: 'session_id', id: '01a006a6-1d07-70a1-bad5-f9110d5845c0' },
        prompt: 'continue the task',
        state: 'working',
        capturedAt: 1,
        updatedAt: 1,
        origin: 'quit',
        launchConfig: { agentCommand: 'claude', agentArgs: '', agentEnv: {} }
      }
    }
  })
  vi.mocked(connectPanePty).mockImplementation((_pane, _manager, deps) => {
    releaseRestart = deps.releaseResumeInPlace
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this test only exercises binding disposal; the connection is mocked.
    return { dispose: () => releaseRestart?.() } as ReturnType<typeof connectPanePty>
  })
  const { result } = renderHook(() =>
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the restart path only reads the pane, transport, and callbacks provided above.
    usePaneProcessRestart({
      tabId: 'tab',
      worktreeId: 'worktree',
      managerRef: { current: { getPanes: () => [{ id: 1, leafId }] } },
      paneTransportsRef: {
        current: new Map([[1, { getPtyId: () => 'old-pty', destroy: () => {} }]])
      },
      panePtyBindingsRef: { current: new Map() },
      suppressPtyExit: () => {},
      clearCodexRestartNotice: () => {},
      clearTabPtyId: () => {
        useAppStore.setState({
          tabsByWorktree: {
            worktree: useAppStore.getState().tabsByWorktree.worktree.map((tab) => ({
              ...tab,
              ptyId: null
            }))
          },
          ptyIdsByTabId: {}
        })
      },
      syncPanePtyLayoutBinding: () => {
        useAppStore.setState({
          activeWorktreeId: 'worktree',
          terminalLayoutsByTabId: {
            tab: {
              root: { type: 'leaf', leafId },
              activeLeafId: leafId,
              expandedLeafId: null,
              ptyIdsByLeafId: {}
            }
          }
        })
        resumeSleepingAgentSessionsForWorktree('worktree')
      },
      setCacheTimerStartedAt: () => {},
      setTerminalError: () => {},
      setTerminalErrorsByPaneId: () => {}
    } as unknown as Parameters<typeof usePaneProcessRestart>[0])
  )

  result.current.handleRestartPane(
    1,
    { command: 'claude --resume 01a006a6-1d07-70a1-bad5-f9110d5845c0' },
    { focus: false }
  )

  expect(useAppStore.getState().tabsByWorktree.worktree.map((tab) => tab.id)).toEqual(['tab'])
})
