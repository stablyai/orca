// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { resolveRemoteForegroundEvidence } from '../../../../main/providers/agent-foreground-process-batch'
import { TerminalResidentRegistry } from './terminal-resident-registry'
import { createTerminalResidentPolicy } from './terminal-resident-policy'
import { createInitialStoreState } from './pty-connection-test-store-fixtures'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import { LEAF_1 } from './pty-connection-test-pane-fixtures'
import type { StoreState } from './pty-connection-test-store-state'
import type { RuntimeTerminalProcessInspection } from '@/runtime/runtime-terminal-inspection'
import {
  installTerminalTestGlobals,
  restoreTerminalTestGlobals
} from './pty-connection-test-environment'

let state: StoreState
const read = vi.fn<() => Promise<RuntimeTerminalProcessInspection>>()
vi.mock('@/store', () => ({
  useAppStore: { getState: () => state, subscribe: () => () => {} }
}))
vi.mock('./use-notification-dispatch', () => ({ dispatchTerminalNotification: vi.fn() }))

const paneKey = makePaneKey('tab-1', LEAF_1)
let epoch = 0
function hostRead(foreground: 'pi' | null): RuntimeTerminalProcessInspection {
  const foregroundPgid = foreground ? 200 : 300
  const root = {
    pid: 100,
    ppid: 1,
    pgid: 100,
    tpgid: foregroundPgid,
    tty: '/dev/pts/2',
    startTime: 'shell-start',
    stat: 'Ss',
    command: '/bin/zsh'
  }
  const evidence = resolveRemoteForegroundEvidence(
    { rootPid: 100, fallbackProcess: 'zsh' },
    {
      ptyId: 'terminal-1',
      ptyIncarnationId: 'inc-1',
      authorityGeneration: 'host-1',
      observationEpoch: ++epoch,
      capturedAgeMs: 0,
      platform: 'linux'
    },
    [
      root,
      { ...root, pid: 200, ppid: 100, pgid: 200, stat: 'S', command: 'pi', startTime: 'pi-start' },
      ...(foreground
        ? []
        : [
            {
              ...root,
              pid: 300,
              ppid: 200,
              pgid: 300,
              stat: 'S+',
              command: 'sleep 60',
              startTime: 'sleep-start'
            }
          ])
    ]
  )
  expect(evidence.verdict).toBe('live')
  return {
    foregroundProcess: evidence.verdict === 'live' ? evidence.processName : null,
    hasChildProcesses: true,
    foregroundProcessEvidence: evidence
  }
}
let end: (() => void) | undefined
function resident() {
  const registry = new TerminalResidentRegistry<ReturnType<typeof createTerminalResidentPolicy>>()
  const current = registry.admit(
    {
      endpoint: 'local',
      executionHost: 'ssh:host-1',
      ptyId: 'ssh:host-1@@terminal-1',
      incarnationId: 'inc-1',
      runtimeId: null
    },
    (captured) =>
      createTerminalResidentPolicy(
        { paneKey, worktreeId: 'wt-1', tabId: 'tab-1', cwd: '/tmp/wt-1' },
        captured.identity,
        () => captured.isLive,
        {
          setCacheTimerStartedAt: vi.fn(),
          markTerminalBell: vi.fn(),
          dispatchNotification: vi.fn()
        }
      )
  )
  state.ptyIdsByTabId!['tab-1'] = [current.identity.ptyId]
  state.terminalLayoutsByTabId!['tab-1']!.ptyIdsByLeafId = { [LEAF_1]: current.identity.ptyId }
  end = () => registry.retire(current)
  return current
}
beforeEach(async () => {
  vi.useFakeTimers()
  epoch = 0
  state = createInitialStoreState(() => state)
  await installTerminalTestGlobals()
  vi.mocked(window.api.pty.inspectProcess).mockImplementation(() => read())
  read.mockReset()
  read.mockImplementation(async () => hostRead('pi'))
})
afterEach(async () => {
  end?.()
  end = undefined
  await restoreTerminalTestGlobals()
  vi.clearAllTimers()
  vi.useRealTimers()
})

it('coalesces hidden accepted aliases through real provider failure, retry and settlement without typed identity', async () => {
  const owner = resident()
  let rejectRead!: (error: Error) => void
  read.mockImplementationOnce(
    () =>
      new Promise((_, reject) => {
        rejectRead = reject
      })
  )
  read.mockImplementationOnce(async () => hostRead(null))
  read.mockImplementationOnce(async () => hostRead('pi'))
  const parser = owner.policy.legacySource
  const tracker = owner.policy.foreground.paneForegroundAgentTracker
  owner.policy.acceptInput('opaque-alias\r')
  for (let i = 0; i < 10; i += 1) {
    await vi.advanceTimersByTimeAsync(30)
    owner.policy.acceptInput('another-alias\r')
  }
  expect(read).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(50)
  expect(read).toHaveBeenCalledOnce()
  expect(state.paneForegroundAgentByPaneKey[paneKey]?.agent).toBeUndefined()
  owner.policy.acceptInput('omp\r')
  await vi.advanceTimersByTimeAsync(1000)
  expect(read).toHaveBeenCalledOnce()
  rejectRead(new Error('temporary provider failure'))
  await vi.advanceTimersByTimeAsync(0)
  await vi.advanceTimersByTimeAsync(1199)
  owner.policy.acceptInput('\x03')
  expect(read).toHaveBeenCalledOnce()
  await vi.advanceTimersByTimeAsync(1)
  expect(read).toHaveBeenCalledTimes(2)
  await vi.advanceTimersByTimeAsync(5999)
  owner.policy.acceptInput('my-alias\r')
  expect(read).toHaveBeenCalledTimes(2)
  await vi.advanceTimersByTimeAsync(1)
  expect(read).toHaveBeenCalledTimes(3)
  expect(state.paneForegroundAgentByPaneKey[paneKey]).toMatchObject({
    agent: 'pi',
    agentEvidence: 'process-read'
  })
  expect(owner.policy.legacySource).toBe(parser)
  expect(owner.policy.foreground.paneForegroundAgentTracker).toBe(tracker)
  expect(tracker.hasReadInFlight()).toBe(false)
  await vi.advanceTimersByTimeAsync(20_000)
  expect(read).toHaveBeenCalledTimes(3)
})

it('terminates null discovery after three real results and wakes again at the callable accepted boundary', async () => {
  const owner = resident()
  read.mockImplementation(async () => hostRead(null))
  owner.policy.acceptInput('an-alias\r')
  await vi.advanceTimersByTimeAsync(350 + 1200 + 6000)
  expect(read).toHaveBeenCalledTimes(3)
  expect(owner.policy.foreground.paneForegroundAgentTracker.hasReadInFlight()).toBe(false)
  await vi.advanceTimersByTimeAsync(20_000)
  expect(read).toHaveBeenCalledTimes(3)
  owner.policy.owner.cancelSuspendedShellCommandInference()
  read.mockImplementation(async () => hostRead('pi'))
  owner.policy.shellInput.observeAcceptedShellCommandInput('a-different-alias\r')
  await vi.advanceTimersByTimeAsync(350)
  expect(read).toHaveBeenCalledTimes(4)
  expect(state.paneForegroundAgentByPaneKey[paneKey]?.agent).toBe('pi')
})

it('rejects a held old-owner provider result after actual retirement and successor discovery', async () => {
  const old = resident()
  let resolveOld!: (value: RuntimeTerminalProcessInspection) => void
  read.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveOld = resolve
      })
  )
  old.policy.acceptInput('my-alias\r')
  await vi.advanceTimersByTimeAsync(350)
  expect(read).toHaveBeenCalledOnce()
  end?.()
  const successor = resident()
  successor.policy.acceptInput('successor-alias\r')
  await vi.advanceTimersByTimeAsync(350)
  const current = state.paneForegroundAgentByPaneKey[paneKey]
  expect(current?.agent).toBe('pi')
  resolveOld(hostRead(null))
  await vi.advanceTimersByTimeAsync(20_000)
  expect(state.paneForegroundAgentByPaneKey[paneKey]).toBe(current)
  expect(read).toHaveBeenCalledTimes(2)
  expect(old.isLive).toBe(false)
  expect(successor.isLive).toBe(true)
})
