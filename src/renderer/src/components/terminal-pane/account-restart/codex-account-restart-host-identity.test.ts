import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store/index'
import {
  selectCodexRestartStatus,
  selectCodexStaleSessionCount
} from '@/components/status-bar/accounts/codex-restart-status-summary'
import { codexAccountRestartToken } from '@/store/terminals/codex-account-restart-continuation'
import type { CodexAccountRestart } from '@/store/terminals/terminal-contracts'
import { resetDeferredPeerChecksForTests } from '@/store/slices/runtime-status/runtime-environment-peer-replacement'
import { replaceRuntimeEnvironmentRevisions } from '@/runtime/rpc/environment-revisions/runtime-environment-revision'
import { routeCodexAccountRestartWake } from './codex-account-restart-wake'
import type { ConnectPanePtySession } from '../pty-connection/connect-pane-pty-session'
import {
  prepareCodexAccountRestart,
  failCodexAccountRestart,
  retryCodexAccountRestarts
} from './codex-account-restart-execution'
import {
  sweepUnclaimedCodexPaneRestarts,
  resetDetachedCodexPaneRestartClaimsForTests
} from './detached/codex-detached-pane-restart'
import {
  acceptSeededCodexRestart,
  key,
  leaf,
  sibling,
  receipt,
  seed,
  snapshot,
  mountedSpawnSession
} from './codex-account-restart.test-fixture'
import { toRuntimeExecutionHostId } from '../../../../../shared/execution-host/execution-host'
import { makeWorktree } from '@/store/slices/worktrees/worktree.test-fixture'
import { TEST_REPO } from '@/store/repos/repo.test-fixture'
import {
  createCompatibleRuntimeStatusResponse,
  createCompatibleRuntimeStatusResponseIfNeeded
} from '@/runtime/rpc/testing/runtime-compatibility-test-fixture'
import type { PublicKnownRuntimeEnvironment } from '../../../../../shared/remote-runtime/host-catalog/runtime-environments'

vi.mock('@/lib/agent-session/accounts/agent-account-restart-startup', () => ({
  captureAgentAccountRestartResumeInput: () => ({ providerSession: { id: 'conversation-1' } }),
  buildPaneAccountRestartStartup: () => ({
    command: 'codex resume conversation-1',
    launchAgent: 'codex'
  })
}))

const call = vi.fn()
const spawn = vi.fn()

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState(), true)
  resetDetachedCodexPaneRestartClaimsForTests()
  call.mockReset().mockResolvedValue(snapshot({ ptyId: 'old', incarnationId: 'inc-old' }))
  spawn.mockReset()
  vi.stubGlobal('window', {
    api: {
      pty: { spawn },
      runtimeEnvironments: {
        call: async (args: { method: string }) =>
          createCompatibleRuntimeStatusResponseIfNeeded(args, 'runtime-before') ?? call(args)
      }
    }
  })
  seed()
})

afterEach(() => {
  resetDetachedCodexPaneRestartClaimsForTests()
  resetDeferredPeerChecksForTests()
  replaceRuntimeEnvironmentRevisions([])
  vi.unstubAllGlobals()
})

const managedSshDeployment = {
  sshTargetId: 'test-ssh',
  sshTargetGeneration: 1,
  localPort: 46_768,
  remotePort: 6_768
}

function pairRemoteHost(
  orcadDeployment?: PublicKnownRuntimeEnvironment['orcadDeployment']
): PublicKnownRuntimeEnvironment {
  const environment: PublicKnownRuntimeEnvironment = {
    id: 'env-account',
    name: 'Test host',
    createdAt: 1,
    updatedAt: 1,
    lastUsedAt: null,
    runtimeId: null,
    pairingRevision: 1,
    hostKeyFingerprint: 'same-host',
    orcadDeployment,
    endpoints: [
      { id: 'ws-account', kind: 'websocket', label: 'WebSocket', endpoint: 'ws://test-host' }
    ],
    preferredEndpointId: 'ws-account'
  }
  useAppStore.getState().setRuntimeEnvironments([environment])
  const hostId = toRuntimeExecutionHostId('env-account')
  useAppStore.setState({
    repos: [{ ...TEST_REPO, id: 'remote-repo', executionHostId: hostId }],
    worktreesByRepo: {
      'remote-repo': [
        makeWorktree({
          id: 'wt',
          repoId: 'remote-repo',
          hostId,
          runtimeOwnerEnvironmentId: 'env-account'
        })
      ]
    }
  })
  useAppStore.getState().setRuntimeEnvironmentStatus('env-account', {
    checkedAt: 1,
    status: createCompatibleRuntimeStatusResponse('runtime-before').result
  })
  return environment
}

async function failEmptyPaneRestart(): Promise<CodexAccountRestart> {
  const request = acceptSeededCodexRestart()
  await prepareCodexAccountRestart(request)
  failCodexAccountRestart(
    codexAccountRestartToken(request),
    receipt(request, 'confirmed-retired', 'empty')
  )
  const [failure] = selectCodexRestartStatus(useAppStore.getState()).failures
  if (!failure) {
    throw new Error('expected a failed restart on the empty pane')
  }
  return failure
}

async function launchEmptyPaneRetry(failure: CodexAccountRestart): Promise<void> {
  call.mockImplementation(async (args: { method: string }) =>
    args.method === 'terminal.create'
      ? {
          ok: true,
          id: 'create',
          result: { terminal: { handle: 'handle-new', incarnationId: 'inc-new' } }
        }
      : snapshot(null, 1)
  )
  await retryCodexAccountRestarts([failure])
  await sweepUnclaimedCodexPaneRestarts()
}

describe('Codex restart host identity', () => {
  it('retires the captured request atomically when its runtime identity changes', async () => {
    pairRemoteHost()
    const request = acceptSeededCodexRestart()
    useAppStore
      .getState()
      .updateCodexAccountRestart(codexAccountRestartToken(request), { phase: 'failed' })
    expect(selectCodexStaleSessionCount(useAppStore.getState())).toBe(1)
    useAppStore.getState().setRuntimeEnvironmentStatus('env-account', {
      checkedAt: 2,
      status: createCompatibleRuntimeStatusResponse('runtime-after').result
    })
    expect(selectCodexRestartStatus(useAppStore.getState()).stalePtyIds).toEqual(['old'])
    expect(selectCodexRestartStatus(useAppStore.getState()).failures).toEqual([])
    useAppStore.getState().setRuntimeEnvironmentStatus('env-account', {
      checkedAt: 3,
      status: createCompatibleRuntimeStatusResponse('runtime-before').result
    })
    await retryCodexAccountRestarts([request])
    expect(selectCodexStaleSessionCount(useAppStore.getState())).toBe(1)
    expect(useAppStore.getState().terminalLayoutsByTabId.tab.ptyIdsByLeafId?.[leaf]).toBe('old')
    expect(spawn).not.toHaveBeenCalled()
  })
  it('retires the captured request when its pairing moves to another machine', async () => {
    const environment = pairRemoteHost()
    const request = acceptSeededCodexRestart()
    useAppStore
      .getState()
      .updateCodexAccountRestart(codexAccountRestartToken(request), { phase: 'failed' })
    expect(selectCodexRestartStatus(useAppStore.getState()).failures).toHaveLength(1)
    // A different host key on the new pairing: another machine, not a same-host rotation.
    useAppStore
      .getState()
      .setRuntimeEnvironments([
        { ...environment, pairingRevision: 2, hostKeyFingerprint: 'other-host' }
      ])
    expect(selectCodexRestartStatus(useAppStore.getState()).failures).toEqual([])
    expect(useAppStore.getState().pendingPaneAccountRestarts[key]).toBeUndefined()
    await retryCodexAccountRestarts([request])
    expect(useAppStore.getState().pendingPaneAccountRestarts[key]).toBeUndefined()
    expect(spawn).not.toHaveBeenCalled()
  })
  it("keeps a failed empty pane's Retry through a same-host re-pair", async () => {
    const environment = pairRemoteHost()
    const request = await failEmptyPaneRestart()
    // Same registration and host key: the re-pair continues the machine the pane ran on.
    useAppStore.getState().setRuntimeEnvironments([{ ...environment, pairingRevision: 2 }])
    const status = selectCodexRestartStatus(useAppStore.getState())
    expect(status.failures).toEqual([
      expect.objectContaining({ requestId: request.requestId, pairingRevision: 2 })
    ])
    expect(selectCodexStaleSessionCount(useAppStore.getState())).toBe(1)
    expect(useAppStore.getState().ptyIdsByTabId.tab).toEqual(['sibling'])
    await launchEmptyPaneRetry(status.failures[0]!)
    expect(useAppStore.getState().terminalLayoutsByTabId.tab.ptyIdsByLeafId?.[leaf]).toBe(
      'remote:env-account@@handle-new'
    )
    expect(selectCodexStaleSessionCount(useAppStore.getState())).toBe(0)
  })

  it('holds Retry until the matching managed SSH host key arrives', async () => {
    const environment = pairRemoteHost(managedSshDeployment)
    const failure = await failEmptyPaneRestart()
    const pendingPairing = { ...environment, pairingRevision: 2, hostKeyFingerprint: undefined }
    useAppStore.getState().setRuntimeEnvironments([pendingPairing])
    expect(selectCodexRestartStatus(useAppStore.getState()).failures).toEqual([])
    call.mockClear()
    await retryCodexAccountRestarts([failure])
    await sweepUnclaimedCodexPaneRestarts()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the pending wake only uses the pane's key.
    const session = mountedSpawnSession(
      failure,
      new Map(),
      vi.fn()
    ) as unknown as ConnectPanePtySession
    await expect(routeCodexAccountRestartWake(session, {})).resolves.toBeNull()
    expect(call).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: expect.stringMatching(/^terminal\./) })
    )
    expect(spawn).not.toHaveBeenCalled()

    const state = useAppStore.getState()
    state.setTabLayout('tab', { ...state.terminalLayoutsByTabId.tab, activeLeafId: sibling })
    state.setRuntimeEnvironments([{ ...pendingPairing, hostKeyFingerprint: 'same-host' }])
    const { failures } = selectCodexRestartStatus(useAppStore.getState())
    expect(failures).toEqual([
      expect.objectContaining({ requestId: failure.requestId, pairingRevision: 2 })
    ])
    await launchEmptyPaneRetry(failures[0]!)
    expect(useAppStore.getState().terminalLayoutsByTabId.tab.ptyIdsByLeafId?.[leaf]).toBe(
      'remote:env-account@@handle-new'
    )
  })

  it('retires held Retry when the managed SSH host key proves a different machine', async () => {
    const environment = pairRemoteHost(managedSshDeployment)
    const failure = await failEmptyPaneRestart()
    const pendingPairing = { ...environment, pairingRevision: 2, hostKeyFingerprint: undefined }
    useAppStore.getState().setRuntimeEnvironments([pendingPairing])
    expect(useAppStore.getState().pendingPaneAccountRestarts[key]).toMatchObject({
      requestId: failure.requestId,
      phase: 'failed'
    })

    useAppStore
      .getState()
      .setRuntimeEnvironments([{ ...pendingPairing, hostKeyFingerprint: 'other-host' }])
    expect(useAppStore.getState().pendingPaneAccountRestarts[key]).toBeUndefined()
    expect(selectCodexRestartStatus(useAppStore.getState()).failures).toEqual([])
    call.mockClear()
    await retryCodexAccountRestarts([failure])
    expect(call).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: expect.stringMatching(/^terminal\./) })
    )
  })
})
