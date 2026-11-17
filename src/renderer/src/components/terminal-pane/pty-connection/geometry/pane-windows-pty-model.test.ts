import { Terminal } from '@xterm/headless'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExecutionHostId } from '../../../../../../shared/execution-host/execution-host'
import type { RuntimeStatus } from '../../../../../../shared/remote-runtime/session-graph/runtime-session-contracts'
import type { SshConnectionState } from '../../../../../../shared/remote-runtime/ssh/ssh-types'
import type { PtyOwnerMachineState } from '../../pty-transport/host-ownership/pty-owner-machine-platform'
import {
  createPaneWindowsPtyModel,
  type PaneWindowsPtyModelContext
} from './pane-windows-pty-model'

vi.mock('@/store/index', () => ({ useAppStore: null }))

const MAC_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)'

beforeEach(() => {
  vi.stubGlobal('navigator', { userAgent: MAC_UA })
  vi.stubGlobal('window', { api: { platform: { get: () => ({ osRelease: '25.3.0' }) } } })
})
afterEach(() => vi.unstubAllGlobals())

function sshState(platform: NodeJS.Platform): SshConnectionState {
  return {
    targetId: 'target-1',
    status: 'connected',
    error: null,
    reconnectAttempt: 0,
    remotePlatform: platform === 'win32' ? 'win32' : 'linux'
  }
}

function serverStatus(platform: NodeJS.Platform) {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the resolver reads only hostPlatform from a verified status.
  return { status: { hostPlatform: platform } as RuntimeStatus, checkedAt: 1 }
}

function fakeStore(initial: PtyOwnerMachineState) {
  let state = initial
  const listeners = new Set<() => void>()
  return {
    getState: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    set(next: Partial<PtyOwnerMachineState>) {
      state = { ...state, ...next }
      listeners.forEach((listener) => listener())
    },
    listenerCount: () => listeners.size
  }
}

const EMPTY: PtyOwnerMachineState = {
  sshConnectionStates: new Map(),
  sshStateByEnvironment: new Map(),
  runtimeStatusByEnvironmentId: new Map()
}

function paneContext(
  terminal: Terminal,
  executionHostId: ExecutionHostId,
  transport: PaneWindowsPtyModelContext['transport'] = null
): () => PaneWindowsPtyModelContext {
  const connectionId = executionHostId === 'ssh:target-1' ? 'target-1' : null
  return () => ({
    terminal,
    owner: { executionHostId, runtimeEnvironmentId: null, connectionId },
    transport
  })
}

function newTerminal(): Terminal {
  return new Terminal({ cols: 80, rows: 24, scrollback: 1000, allowProposedApi: true })
}

async function write(terminal: Terminal, data: string): Promise<void> {
  await new Promise<void>((resolve) => terminal.write(data, resolve))
}

async function scrollbackAfterShrinkAndGrow(terminal: Terminal): Promise<number> {
  await write(terminal, Array.from({ length: 60 }, (_, i) => `H${i}`).join('\r\n'))
  const before = terminal.buffer.active.baseY
  terminal.resize(80, 2)
  terminal.resize(80, 24)
  return terminal.buffer.active.baseY - before
}

// A Mac client showing a remote Windows pane grew it the Unix way, pulling history into ConPTY's
// grid; ConPTY repaints only what it thinks changed, so stale TUI frames stayed on screen.
describe('pane resize model on a Mac client', () => {
  it("follows the bound transport's SSH owner, not the Windows server that mirrors it", async () => {
    const terminal = newTerminal()
    const store = fakeStore({
      ...EMPTY,
      runtimeStatusByEnvironmentId: new Map([['env-1', serverStatus('win32')]]),
      sshStateByEnvironment: new Map([
        [
          'env-1',
          {
            connectionStates: new Map([['target-1', sshState('linux')]]),
            targetLabels: new Map(),
            targetGenerations: new Map(),
            removedTargetLabels: new Map(),
            targetsHydrated: true
          }
        ]
      ])
    })
    const transport = {
      getRuntimeEnvironmentId: () => 'env-1',
      getExecutionHostId: (): ExecutionHostId => 'ssh:target-1'
    }
    createPaneWindowsPtyModel(paneContext(terminal, 'runtime:env-1', transport), store).apply()
    expect(await scrollbackAfterShrinkAndGrow(terminal)).toBeLessThanOrEqual(0)
  })

  it("falls back to the pane's own SSH owner while the transport cannot name its host", async () => {
    const terminal = newTerminal()
    const store = fakeStore({
      ...EMPTY,
      runtimeStatusByEnvironmentId: new Map([['env-1', serverStatus('linux')]]),
      sshStateByEnvironment: new Map([
        [
          'env-1',
          {
            connectionStates: new Map([['target-1', sshState('win32')]]),
            targetLabels: new Map(),
            targetGenerations: new Map(),
            removedTargetLabels: new Map(),
            targetsHydrated: true
          }
        ]
      ])
    })
    const transport = {
      getRuntimeEnvironmentId: () => 'env-1',
      getExecutionHostId: () => null
    }
    createPaneWindowsPtyModel(paneContext(terminal, 'ssh:target-1', transport), store).apply()
    expect(await scrollbackAfterShrinkAndGrow(terminal)).toBeGreaterThan(0)
  })

  // A one-time restore write must not trust the previous owner's answer while the new owner's OS is unknown.
  it('reports an unknown backend after the transport re-names a host whose OS has not arrived', () => {
    const terminal = newTerminal()
    const store = fakeStore({
      ...EMPTY,
      runtimeStatusByEnvironmentId: new Map([['env-1', serverStatus('linux')]])
    })
    let host: ExecutionHostId | null = null
    let onHostChange: () => void = () => {}
    const transport = {
      getRuntimeEnvironmentId: () => 'env-1',
      getExecutionHostId: () => host,
      onExecutionHostChange: (listener: () => void) => {
        onHostChange = listener
        return () => {}
      }
    }
    const model = createPaneWindowsPtyModel(
      paneContext(terminal, 'runtime:env-1', transport),
      store
    )
    model.apply()
    expect(model.ownerUsesConpty()).toBe(false)

    host = 'ssh:target-1'
    onHostChange()
    expect(model.ownerUsesConpty()).toBe(null)

    store.set({
      sshStateByEnvironment: new Map([
        [
          'env-1',
          {
            connectionStates: new Map([['target-1', sshState('win32')]]),
            targetLabels: new Map(),
            targetGenerations: new Map(),
            removedTargetLabels: new Map(),
            targetsHydrated: true
          }
        ]
      ])
    })
    expect(model.ownerUsesConpty()).toBe(true)
  })
})
