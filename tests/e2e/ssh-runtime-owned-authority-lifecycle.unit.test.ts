import { beforeEach, expect, it, vi } from 'vitest'
import type { SshTarget } from '../../src/shared/ssh-types'

const mocks = await vi.hoisted(async () => {
  const { createSshIpcMocks } = await import('../../src/main/ipc/ssh-ipc-module-mocks')
  return createSshIpcMocks()
})

vi.mock('../../src/main/ssh/ssh-config-host-picker', () => mocks.sshConfigHostPicker)
vi.mock('electron', () => mocks.electron)
vi.mock('../../src/main/ipc/ssh-pty-output-intake-registry', () => mocks.sshPtyOutputIntakeRegistry)
vi.mock('../../src/main/ssh/ssh-connection-store', () => mocks.sshConnectionStore)
vi.mock('../../src/main/ssh/ssh-connection-manager', () => mocks.sshConnectionManager)
vi.mock('../../src/main/ssh/ssh-relay-deploy', () => mocks.sshRelayDeploy)
vi.mock('../../src/main/ssh/ssh-relay-reset', () => mocks.sshRelayReset)
vi.mock('../../src/main/ssh/ssh-channel-multiplexer', () => mocks.sshChannelMultiplexer)
vi.mock('../../src/main/providers/ssh-pty-provider', () => mocks.sshPtyProvider)
vi.mock('../../src/main/providers/ssh-filesystem-provider', () => mocks.sshFilesystemProvider)
vi.mock('../../src/main/ipc/pty', () => mocks.pty)
vi.mock('../../src/main/providers/ssh-filesystem-dispatch', () => mocks.sshFilesystemDispatch)
vi.mock('../../src/main/providers/ssh-git-provider', () => mocks.sshGitProvider)
vi.mock('../../src/main/providers/ssh-git-dispatch', () => mocks.sshGitDispatch)
vi.mock('../../src/main/ssh/ssh-port-forward', () => mocks.sshPortForward)
vi.mock('../../src/main/ssh/ssh-port-scanner', () => mocks.sshPortScanner)

import { activeSessions } from '../../src/main/ipc/ssh-active-relay-sessions'
import { getSshConnectionGeneration } from '../../src/main/ssh/ssh-connection-generation'
import { createSshIpcHarness } from '../../src/main/ipc/ssh-ipc-test-harness'
import { useAppStore } from '@/store'
import { registerRuntimeOwnedSshAuthorityIpcBridge } from '@/hooks/ipc-events/runtime-owned-ssh-authority-ipc-bridge'
import {
  admitRuntimeOwnedSshAuthority,
  type RuntimeOwnedSshAuthority
} from '../../src/shared/runtime-owned-ssh-authority'

const { mockSshStore, mockConnectionManager, mockPtyProvider } = mocks
const harness = createSshIpcHarness(mocks)
const { handlers, mockStore, mockWindow } = harness
beforeEach(harness.reset)

it('recovers a fresh renderer bridge after termination fails with a ready session retained', async () => {
  const targetId = 'runtime-ssh-retained'
  mockSshStore.getTarget.mockReturnValue({
    id: targetId,
    label: 'Runtime host',
    host: 'example.com',
    port: 22,
    username: 'deploy'
  } satisfies SshTarget)
  mockConnectionManager.connect.mockResolvedValue({})
  mockConnectionManager.getState.mockReturnValue({
    targetId,
    status: 'connected',
    error: null,
    reconnectAttempt: 0
  })
  await handlers.get('ssh:connect')!(null, { targetId })
  mockStore.getSshRemotePtyLeases.mockReturnValue([
    { targetId, ptyId: 'owned-pty', state: 'detached' }
  ])
  if (!vi.isMockFunction(mocks.pty.getSshPtyProvider)) {
    throw new Error('Missing SSH provider mock')
  }
  mocks.pty.getSshPtyProvider.mockReturnValue(mockPtyProvider)
  const shutdown = Promise.withResolvers<void>()
  mockPtyProvider.shutdown.mockReturnValueOnce(shutdown.promise)
  const termination = handlers.get('ssh:terminateSessions')!(null, { targetId })
  const rejected = expect(termination).rejects.toThrow('Failed to terminate SSH host sessions')
  let receive: (authority: RuntimeOwnedSshAuthority) => void = () => {}
  useAppStore.setState({ runtimeOwnedSshConnectionGenerations: new Map() })
  vi.stubGlobal('window', {
    api: {
      ssh: {
        onRuntimeOwnedAuthorityChanged: (listener: typeof receive) => {
          receive = listener
          return () => {}
        },
        listRuntimeOwnedAuthorities: async () => {
          const snapshot = handlers.get('ssh:listRuntimeOwnedAuthorities')!(null, {})
          if (!Array.isArray(snapshot)) {
            throw new Error('Missing authority snapshot')
          }
          return snapshot.map(admitRuntimeOwnedSshAuthority).filter((entry) => entry !== null)
        }
      }
    }
  })
  mockWindow.webContents.send.mockImplementation((channel, payload) => {
    const authority = admitRuntimeOwnedSshAuthority(payload)
    if (channel === 'ssh:runtime-owned-authority-changed' && authority) {
      receive(authority)
    }
  })
  const disposers: (() => void)[] = []
  try {
    registerRuntimeOwnedSshAuthorityIpcBridge(disposers)
    await Promise.resolve()
    expect(useAppStore.getState().runtimeOwnedSshConnectionGenerations.has(targetId)).toBe(false)
    shutdown.reject(new Error('Host shutdown failed'))
    await rejected
    expect(activeSessions.get(targetId)?.getState()).toBe('ready')
    expect(useAppStore.getState().runtimeOwnedSshConnectionGenerations.get(targetId)).toBe(
      getSshConnectionGeneration(targetId)
    )
  } finally {
    shutdown.resolve()
    await rejected
    disposers.forEach((dispose) => dispose())
    vi.unstubAllGlobals()
  }
})
