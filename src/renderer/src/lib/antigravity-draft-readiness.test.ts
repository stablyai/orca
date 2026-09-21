import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ANTIGRAVITY_VISIBLE_READINESS_RUNTIME_CAPABILITY as capability } from '../../../shared/protocol-version'
import type * as RuntimeRpcClient from '@/runtime/runtime-rpc-client'
import { waitForAntigravityDraftReady } from './antigravity-draft-readiness'

const leaf = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const mocks = vi.hoisted(() => {
  const state: {
    ptyIdsByTabId: Record<string, string[]>
    terminalLayoutsByTabId: Record<string, { ptyIdsByLeafId: Record<string, string> }>
  } = { ptyIdsByTabId: { tab: ['pty'] }, terminalLayoutsByTabId: {} }
  return {
    call: vi.fn(),
    capabilities: vi.fn(),
    remoteCapability: vi.fn(),
    state
  }
})
vi.mock('@/store', () => ({ useAppStore: { getState: () => mocks.state } }))
vi.mock('@/runtime/local-runtime-capabilities', () => ({
  ensureLocalRuntimeCapabilities: mocks.capabilities
}))
vi.mock('@/runtime/runtime-rpc-client', async (importOriginal) => {
  const actual = await importOriginal<typeof RuntimeRpcClient>()
  return {
    ...actual,
    callRuntimeRpc: mocks.call,
    runtimeEnvironmentSupportsCapability: mocks.remoteCapability,
    getActiveRuntimeTarget: (settings?: { activeRuntimeEnvironmentId?: string }) =>
      settings?.activeRuntimeEnvironmentId
        ? { kind: 'environment', environmentId: settings.activeRuntimeEnvironmentId }
        : { kind: 'local' }
  }
})

const ready = {
  handle: 'term_test',
  condition: 'tui-idle',
  satisfied: true,
  status: 'running',
  exitCode: null
}

describe('Antigravity host-owned draft readiness', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal('window', { setTimeout, clearTimeout })
    mocks.state.ptyIdsByTabId = { tab: ['pty'] }
    mocks.state.terminalLayoutsByTabId = { tab: { ptyIdsByLeafId: { [leaf]: 'pty' } } }
    mocks.capabilities.mockReset().mockResolvedValue([capability])
    mocks.remoteCapability.mockReset().mockResolvedValue(true)
    mocks.call.mockReset().mockImplementation(async (_target, method) =>
      method === 'terminal.show'
        ? {
            terminal: {
              handle: 'term_test',
              ptyId: 'pty',
              connected: true,
              writable: true,
              agentIdentity: 'antigravity'
            }
          }
        : method === 'terminal.resolvePane'
          ? { terminal: { handle: 'term_test', tabId: 'tab', leafId: leaf, ptyId: 'pty' } }
          : { wait: ready }
    )
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('waits for the exact pane on its owning host', async () => {
    await expect(waitForAntigravityDraftReady('tab', 'pty', 60000, null)).resolves.toBe(true)
    expect(mocks.call).toHaveBeenCalledWith(
      { kind: 'local' },
      'terminal.resolvePane',
      { paneKey: `tab:${leaf}` },
      expect.anything()
    )
    expect(mocks.call).toHaveBeenCalledWith(
      { kind: 'local' },
      'terminal.wait',
      { terminal: 'term_test', for: 'tui-idle', timeoutMs: 60000 },
      expect.anything()
    )
  })

  it('routes a paired PTY to its owner even when another host is selected', async () => {
    const pty = 'remote:host-b@@term_test'
    mocks.state.ptyIdsByTabId.tab = [pty]
    mocks.state.terminalLayoutsByTabId.tab = { ptyIdsByLeafId: { [leaf]: pty } }
    await expect(
      waitForAntigravityDraftReady('tab', pty, 60000, { activeRuntimeEnvironmentId: 'host-a' })
    ).resolves.toBe(true)
    expect(mocks.remoteCapability).toHaveBeenCalledWith('host-b', capability, 5000)
    expect(mocks.call).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'host-b' },
      'terminal.wait',
      { terminal: 'term_test', for: 'tui-idle', timeoutMs: 60000 },
      expect.anything()
    )
    expect(mocks.capabilities).not.toHaveBeenCalled()
  })

  it('does not paste on old local or paired hosts', async () => {
    mocks.capabilities.mockResolvedValue([])
    mocks.remoteCapability.mockResolvedValue(false)
    await expect(waitForAntigravityDraftReady('tab', 'pty', 60000, null)).resolves.toBe(false)
    await expect(
      waitForAntigravityDraftReady('tab', 'pty', 60000, { activeRuntimeEnvironmentId: 'host-b' })
    ).resolves.toBe(false)
    expect(mocks.remoteCapability).toHaveBeenCalledWith('host-b', capability, 5000)
    expect(mocks.call).not.toHaveBeenCalled()
  })

  it.each([
    { satisfied: false },
    { status: 'exited' },
    { blockedReason: 'agent-trust-workspace' },
    { handle: 'term_other' }
  ])('rejects an unusable wait verdict: %j', async (change) => {
    mocks.call.mockImplementation(async (_target, method) =>
      method === 'terminal.resolvePane'
        ? { terminal: { handle: 'term_test', ptyId: 'pty' } }
        : { wait: { ...ready, ...change } }
    )
    await expect(waitForAntigravityDraftReady('tab', 'pty', 60000, null)).resolves.toBe(false)
  })

  it('rejects a different agent that took over the same PTY while waiting', async () => {
    mocks.call.mockImplementation(async (_target, method) =>
      method === 'terminal.wait'
        ? { wait: ready }
        : {
            terminal: {
              handle: 'term_test',
              ptyId: 'pty',
              connected: true,
              writable: true,
              agentIdentity: 'codex'
            }
          }
    )
    await expect(waitForAntigravityDraftReady('tab', 'pty', 60000, null)).resolves.toBe(false)
  })

  it('rejects loss of host contact', async () => {
    mocks.call.mockRejectedValue(new Error('transport disconnected'))
    await expect(waitForAntigravityDraftReady('tab', 'pty', 60000, null)).resolves.toBe(false)
    expect(mocks.call).toHaveBeenCalledTimes(1)
  })

  it('rejects a ready answer after the pane was replaced', async () => {
    mocks.call.mockImplementation(async (_target, method) => {
      if (method === 'terminal.resolvePane') {
        return { terminal: { handle: 'term_test', ptyId: 'pty' } }
      }
      mocks.state.ptyIdsByTabId.tab = ['replacement']
      return { wait: ready }
    })
    await expect(waitForAntigravityDraftReady('tab', 'pty', 60000, null)).resolves.toBe(false)
  })

  it('waits for publication of a newly bound pane without trusting the shell', async () => {
    mocks.call.mockRejectedValueOnce(new Error('terminal_not_found'))
    const waiting = waitForAntigravityDraftReady('tab', 'pty', 60000, null)
    await vi.advanceTimersByTimeAsync(100)
    await expect(waiting).resolves.toBe(true)
    expect(mocks.call).toHaveBeenCalledTimes(4)
  })
})
