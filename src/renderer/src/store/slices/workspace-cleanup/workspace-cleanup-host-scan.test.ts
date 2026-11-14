import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '../../types'
import type { Repo } from '../../../../../shared/repo-types'
import type { Worktree } from '../../../../../shared/worktree/types'
import {
  installWorkspaceCleanupApi,
  makeCandidate,
  makeState,
  NOW
} from './workspace-cleanup-slice-test-harness'

const { callRuntimeRpcMock } = vi.hoisted(() => ({ callRuntimeRpcMock: vi.fn() }))
vi.mock('../../../runtime/rpc/calls/runtime-rpc-call', () => ({
  callRuntimeRpc: callRuntimeRpcMock
}))

import {
  cancelWorkspaceCleanupHostScan,
  scanWorkspaceCleanupHosts
} from './workspace-cleanup-host-scan'

const LOCAL_REPO = {
  id: 'local-repo',
  path: '/l',
  displayName: 'Local',
  badgeColor: '#000',
  addedAt: NOW
} satisfies Repo
const REMOTE_REPO = {
  id: 'remote-repo',
  path: '/r',
  displayName: 'Remote',
  badgeColor: '#000',
  addedAt: NOW,
  executionHostId: 'runtime:env-1'
} satisfies Repo
const REMOTE_ID = 'remote-repo::/r/feature'

function state() {
  return makeState({
    repos: [LOCAL_REPO, REMOTE_REPO],
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the host scan reads only the environment id
    runtimeEnvironments: [{ id: 'env-1' }] as unknown as AppState['runtimeEnvironments'],
    worktreesByRepo: {
      'remote-repo': [
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: unreachable rows read only these catalog fields
        {
          id: REMOTE_ID,
          repoId: 'remote-repo',
          path: '/r/feature',
          branch: 'refs/heads/feature',
          displayName: 'feature',
          isArchived: false,
          lastActivityAt: NOW
        } as unknown as Worktree
      ]
    }
  })
}

describe('scanWorkspaceCleanupHosts', () => {
  beforeEach(() => {
    callRuntimeRpcMock.mockReset()
    installWorkspaceCleanupApi(
      vi.fn().mockResolvedValue({
        scannedAt: NOW,
        candidates: [makeCandidate({ worktreeId: 'local-repo::/l/a', repoId: 'local-repo' })],
        errors: []
      })
    )
  })

  it('asks the owning server for its rows and names them by this window’s host id', async () => {
    callRuntimeRpcMock.mockResolvedValue({
      scannedAt: NOW,
      candidates: [makeCandidate({ worktreeId: REMOTE_ID, repoId: 'remote-repo' })],
      errors: []
    })

    const result = await scanWorkspaceCleanupHosts(
      { worktreeIds: ['local-repo::/l/a', REMOTE_ID] },
      state()
    )

    expect(callRuntimeRpcMock).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'env-1' },
      'workspaceCleanup.scan',
      { worktreeIds: [REMOTE_ID] },
      expect.anything()
    )
    expect(result.candidates.map((c) => [c.worktreeId, c.executionHostId])).toEqual([
      ['local-repo::/l/a', 'local'],
      [REMOTE_ID, 'runtime:env-1']
    ])
  })

  it('keeps an unreachable host’s known rows, blocked as remote unavailable', async () => {
    callRuntimeRpcMock.mockRejectedValue(new Error('Runtime environment is offline'))

    const result = await scanWorkspaceCleanupHosts({ includeAllWorkspaces: true }, state())

    const remote = result.candidates.find((c) => c.worktreeId === REMOTE_ID)
    expect(remote).toMatchObject({
      executionHostId: 'runtime:env-1',
      branch: 'feature',
      blockers: ['ssh-disconnected'],
      git: { clean: null, checkedAt: null }
    })
  })

  it('cancelling a scan closes its request to the host', async () => {
    let hostSignal: AbortSignal | undefined
    callRuntimeRpcMock.mockImplementation(
      (_target, _method, _params, options: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          hostSignal = options.signal
          options.signal.addEventListener('abort', () => reject(new Error('aborted')))
        })
    )

    const scan = scanWorkspaceCleanupHosts(
      { includeAllWorkspaces: true, scanId: 'scan-1' },
      state()
    )
    await vi.waitFor(() => expect(hostSignal).toBeDefined())
    await cancelWorkspaceCleanupHostScan('scan-1')

    expect(hostSignal?.aborted).toBe(true)
    expect((await scan).candidates.map((c) => c.worktreeId)).toEqual(['local-repo::/l/a'])
  })
})
