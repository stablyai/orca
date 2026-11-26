import { expect, it, vi } from 'vitest'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import { runtimeEnvironmentCapabilityProof } from '@/runtime/rpc/compatibility/runtime-capability-proof'
import type { ConnectPanePtySession } from '../connect-pane-pty-session'
import { prepareQueuedStartupCommand } from './prepare-queued-startup-command'

vi.mock('@/store', () => ({ useAppStore: { getState: () => ({}) } }))
vi.mock('@/store/slices/runtime-status/views/runtime-status-owner', () => ({
  readRuntimeStatuses: () => new Map()
}))
vi.mock('@/lib/workspace/creation/new-workspace', () => ({ CLIENT_PLATFORM: 'linux' }))
vi.mock('@/runtime/hosted-terminals/identity/remote-runtime-pty-owner', () => ({
  getRemoteRuntimePtyOwner: () => ({
    target: { kind: 'environment', environmentId: 'host' },
    terminal: 'pane'
  })
}))
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({ callRuntimeRpc: vi.fn() }))
vi.mock('@/runtime/rpc/compatibility/runtime-capability-proof', () => ({
  runtimeEnvironmentCapabilityProof: vi.fn()
}))

it('withholds an unverified saved command even while the paired pane remains current', async () => {
  vi.mocked(runtimeEnvironmentCapabilityProof).mockResolvedValue({
    supported: true,
    runtimeId: 'runtime',
    pairingRevision: undefined
  })
  vi.mocked(callRuntimeRpc).mockRejectedValue(new Error('preflight failed'))
  const fixture = {
    transport: { getRemotePlatform: () => 'linux' },
    executionHostId: 'local',
    deps: { cwd: '/workspace' }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fixture supplies the host and cwd fields this preparation reads.
  const session = fixture as unknown as ConnectPanePtySession
  await expect(
    prepareQueuedStartupCommand(
      session,
      'remote:host@@pane',
      { command: 'claude --resume saved', restoring: true },
      () => true
    )
  ).resolves.toEqual({ preparedCommand: null })
})
