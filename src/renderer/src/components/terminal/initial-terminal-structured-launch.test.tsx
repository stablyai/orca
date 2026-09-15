// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useTerminalWatcherEffects } from '../use-terminal-watcher-effects'
import type { TerminalColdActivationController } from '../terminal-cold-activation'

const mocks = vi.hoisted(() => {
  let uuid = 0
  return {
    recover: vi.fn(),
    produce: vi.fn(),
    nextUuid: () => `startup-recovery-${++uuid}`,
    resetUuid: () => {
      uuid = 0
    }
  }
})

vi.mock('@/store', () => ({
  useAppStore: Object.assign(
    (
      selector: (state: {
        activeWorkspaceExecutionHostId: null
        runtimeEnvironments: readonly []
      }) => unknown
    ) => selector({ activeWorkspaceExecutionHostId: null, runtimeEnvironments: [] }),
    {
      getState: () => ({ activeWorktreeId: 'folder:workspace-1' })
    }
  )
}))
vi.mock('@/lib/worktree-activation-recovery', () => ({
  recoverWorkspaceActivation: mocks.recover
}))
vi.mock('@/lib/workspace-activation-surface-producer', () => ({
  startWorkspaceActivationSurfaceProducer: mocks.produce
}))
vi.mock('@/lib/worktree-runtime-owner', () => ({
  getExecutionHostIdForWorktree: () => 'local',
  getRuntimeEnvironmentIdForWorktree: () => null
}))
vi.mock('@/lib/browser-uuid', () => ({ createBrowserUuid: mocks.nextUuid }))
vi.mock('@/lib/resume-sleeping-agent-session', () => ({
  resumeSleepingAgentSessionsForWorktree: vi.fn()
}))
vi.mock('@/lib/workspace-terminal-host-authority', () => ({
  createWorkspaceTerminalHostAuthoritySelector: () => () => 'none'
}))
vi.mock('../terminal-pane/terminal-parked-tab-watchers', () => ({
  pruneParkedTerminalWatchers: vi.fn(),
  terminalWatcherLiveWorkspaceIds: () => new Set(),
  syncParkedTerminalTabWatchersForWorkspaces: vi.fn(),
  disposeAllParkedTerminalWatchers: vi.fn()
}))

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
  writable: true
})
let root: Root | undefined

afterEach(async () => {
  await act(async () => root?.unmount())
  root = undefined
  mocks.recover.mockReset()
  mocks.produce.mockReset()
  mocks.resetUuid()
})

function Watcher({ activeWorktreeId }: { activeWorktreeId: string }): null {
  const controller = {
    activeWorktreeId,
    workspaceSessionReady: true,
    terminalStartupRestorationReady: true,
    workspaceSurfaceIds: [],
    tabsByWorktree: {}
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This hook test exercises only the startup fields; unused controller dependencies stay inert.
  useTerminalWatcherEffects(controller as unknown as TerminalColdActivationController)
  return null
}

describe('passive activation recovery', () => {
  it('observes the folder-key general-setter path during startup', async () => {
    mocks.recover.mockResolvedValue({ kind: 'intentional-empty' })
    root = createRoot(document.createElement('div'))

    await act(async () => root?.render(<Watcher activeWorktreeId="folder:workspace-1" />))

    expect(mocks.recover).toHaveBeenCalledWith(
      {
        workspaceKey: 'folder:workspace-1',
        executionHostId: 'local',
        runtimeEnvironmentId: null,
        attemptId: 'startup-recovery-1'
      },
      { mode: 'startup', signal: expect.any(AbortSignal) }
    )
    expect(mocks.produce).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceKey: 'folder:workspace-1' }),
      { mode: 'startup' }
    )
  })

  it('observes every later general-setter selection', async () => {
    mocks.recover.mockResolvedValue({ kind: 'materialized' })
    root = createRoot(document.createElement('div'))
    await act(async () => root?.render(<Watcher activeWorktreeId="worktree-1" />))
    await act(async () => undefined)

    await act(async () => root?.render(<Watcher activeWorktreeId="worktree-2" />))

    expect(mocks.recover).toHaveBeenCalledTimes(2)
    expect(mocks.produce).toHaveBeenCalledTimes(2)
    expect(mocks.recover.mock.calls.map(([request]) => request.workspaceKey)).toEqual([
      'worktree-1',
      'worktree-2'
    ])
  })

  it('aborts an unsettled request without consuming the next startup assessment', async () => {
    let settleSecond!: () => void
    mocks.recover.mockReturnValueOnce(new Promise(() => undefined)).mockReturnValueOnce(
      new Promise((resolve) => {
        settleSecond = () => resolve({ kind: 'intentional-empty' })
      })
    )
    root = createRoot(document.createElement('div'))
    await act(async () => root?.render(<Watcher activeWorktreeId="worktree-1" />))
    const firstSignal = mocks.recover.mock.calls[0]?.[1]?.signal

    await act(async () => root?.render(<Watcher activeWorktreeId="folder:workspace-2" />))

    expect(firstSignal?.aborted).toBe(true)
    expect(mocks.recover).toHaveBeenCalledTimes(2)
    await act(async () => settleSecond())
  })
})
