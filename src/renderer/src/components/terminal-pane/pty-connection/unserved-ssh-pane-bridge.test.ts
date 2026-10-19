import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { LegacyRelayBridgedPane } from '../../../../../shared/legacy-relay-bridge-contract'
import type { SshConnectionState } from '../../../../../shared/ssh-types'
import type { ConnectPanePtySession } from './connect-pane-pty-session'

const PTY = 'ssh:ssh-box@@pty-1'

const mocks = vi.hoisted(() => ({
  attach: vi.fn(async () => ({
    status: 'attached' as const,
    replay: 'old screen',
    acquisitionId: 1
  })),
  panes: new Set<(panes: LegacyRelayBridgedPane[]) => void>(),
  states: new Map<string, Partial<SshConnectionState>>()
}))

vi.stubGlobal('window', {
  api: {
    legacyRelayBridge: {
      listPanes: vi.fn(async () => []),
      attach: mocks.attach,
      write: vi.fn(),
      resize: vi.fn(),
      detach: vi.fn(),
      setOutputPaused: vi.fn(),
      onPanes: (listener: (panes: LegacyRelayBridgedPane[]) => void) => {
        mocks.panes.add(listener)
        return () => mocks.panes.delete(listener)
      },
      onData: () => () => {},
      onReplay: () => () => {},
      onExit: () => () => {}
    }
  }
})
vi.mock('@/store', () => ({
  useAppStore: { getState: () => ({ sshConnectionStates: mocks.states }) }
}))
vi.mock('@/ssh/ssh-connect-in-flight', () => ({
  isSshConnectInFlight: () => false,
  trackSshConnect: <T>(_: string, promise: T) => promise
}))

const { createUnservedSshRowTransport } = await import('./unserved-ssh-pane-connect')
const { legacyRelayBridgePtyIdForPane } = await import('../legacy-relay-bridge-panes')

function publishPanes(panes: LegacyRelayBridgedPane[]): void {
  mocks.panes.forEach((listener) => listener(panes))
}

function session(tabId: string, leafId: string): ConnectPanePtySession {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the row transport reads only these fields.
  return { deps: { tabId }, pane: { leafId } } as unknown as ConnectPanePtySession
}

const bridgedHost: Partial<SshConnectionState> = {
  status: 'connected',
  managedServer: { kind: 'relay', reason: 'relay_terminals_live', terminals: 1, bridged: true }
}
const pane: LegacyRelayBridgedPane = {
  ptyId: PTY,
  targetId: 'ssh-box',
  tabId: 'tab-1',
  leafId: 'leaf-1',
  state: 'live'
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.states.clear()
  publishPanes([])
})

describe('a relay-era ssh: row on a host that stayed unmoved for its relay terminals', () => {
  it('reattaches the terminal main serves in its old tab (STA-10604)', async () => {
    mocks.states.set('ssh-box', bridgedHost)
    publishPanes([pane])
    const s = session('tab-1', 'leaf-1')
    const transport = createUnservedSshRowTransport(s, 'ssh-box')
    expect(s.legacyRelayBridgePtyId).toBe(PTY)
    const onConnect = vi.fn()
    const result = await transport.connect({
      url: '',
      sessionId: PTY,
      callbacks: { onConnect }
    })
    expect(mocks.attach).toHaveBeenCalledWith({ ptyId: PTY })
    expect(onConnect).toHaveBeenCalled()
    expect(result).toMatchObject({ id: PTY, isReattach: true, replay: 'old screen' })
    // Unmounting (a detach, for a bound pane) frees the shell for the converted row's pane.
    transport.detach?.()
    expect(
      legacyRelayBridgePtyIdForPane({
        tabId: 'web-terminal-tab-1',
        leafId: 'leaf-1',
        boundPtyId: null
      })
    ).toBe(PTY)
  })

  it('stays inert on a host that was not kept for the bridge', () => {
    publishPanes([pane])
    mocks.states.set('ssh-box', {
      status: 'error',
      managedServer: { kind: 'relay', reason: 'refused' }
    })
    const s = session('tab-1', 'leaf-1')
    createUnservedSshRowTransport(s, 'ssh-box')
    expect(s.legacyRelayBridgePtyId).toBeUndefined()
  })

  it('stays inert for a pane main does not list, so it still dials the host', () => {
    mocks.states.set('ssh-box', bridgedHost)
    publishPanes([pane])
    const s = session('tab-1', 'leaf-2')
    createUnservedSshRowTransport(s, 'ssh-box')
    expect(s.legacyRelayBridgePtyId).toBeUndefined()
  })
})
