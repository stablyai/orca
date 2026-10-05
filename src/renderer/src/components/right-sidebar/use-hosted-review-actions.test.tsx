// @vitest-environment happy-dom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PRInfo } from '../../../../shared/github/pull-request-types'
import type { Repo } from '../../../../shared/repo-types'
import { useHostedReviewActions, type HostedReviewActionInfo } from './use-hosted-review-actions'

const confirmationMocks = vi.hoisted(() => ({
  confirm: vi.fn()
}))

const runtimeRpcMocks = vi.hoisted(() => ({
  callRuntimeRpc: vi.fn(),
  assertRuntimeEnvironmentCapability: vi.fn()
}))

vi.mock('@/components/confirmation-dialog-context', () => ({
  useConfirmationDialog: () => confirmationMocks.confirm
}))

vi.mock('@/runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: runtimeRpcMocks.callRuntimeRpc,
  assertRuntimeEnvironmentCapability: runtimeRpcMocks.assertRuntimeEnvironmentCapability
}))

const prRepo = { host: 'github.com', owner: 'stablyai', repo: 'orca-sta1015-sandbox' }
const review: HostedReviewActionInfo = {
  provider: 'github',
  number: 1015,
  state: 'open',
  status: 'success',
  mergeable: 'MERGEABLE'
}
const githubPR = { prRepo } as unknown as PRInfo

let root: Root | null = null
let latest: ReturnType<typeof useHostedReviewActions> | null = null

function makeRepo(overrides: Partial<Repo> = {}): Repo {
  return {
    id: 'repo-1',
    path: '/repo',
    displayName: 'repo',
    kind: 'git',
    connectionId: null,
    ...overrides
  } as Repo
}

function HookProbe(props: {
  repo: Repo
  onRefreshReview: () => Promise<void>
  pullRequest?: PRInfo
  isGitLab?: boolean
}): null {
  latest = useHostedReviewActions({
    review,
    githubPR: props.pullRequest ?? githubPR,
    repo: props.repo,
    isGitLab: props.isGitLab ?? false,
    shortLabel: 'PR',
    reviewLabel: 'pull request',
    defaultMergeMethod: 'squash',
    autoMergeAction: null,
    onRefreshReview: props.onRefreshReview
  })
  return null
}

async function renderHook(
  repo: Repo,
  onRefreshReview = vi.fn().mockResolvedValue(undefined),
  pullRequest?: PRInfo,
  isGitLab = false
) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root?.render(createElement(HookProbe, { repo, onRefreshReview, pullRequest, isGitLab }))
  })
  return { onRefreshReview }
}

describe('useHostedReviewActions', () => {
  beforeEach(() => {
    confirmationMocks.confirm.mockReset().mockResolvedValue(true)
    runtimeRpcMocks.callRuntimeRpc.mockReset().mockResolvedValue({ ok: true })
    runtimeRpcMocks.assertRuntimeEnvironmentCapability.mockReset().mockResolvedValue(undefined)
    latest = null
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test-only window.api shim
    ;(window as any).api = {
      gh: {
        mergePR: vi.fn().mockResolvedValue({ ok: true }),
        setPRAutoMerge: vi.fn().mockResolvedValue({ ok: true }),
        updatePRState: vi.fn().mockResolvedValue({ ok: true }),
        markPRReadyForReview: vi.fn().mockResolvedValue({ ok: true })
      },
      gl: {
        mergeMR: vi.fn().mockResolvedValue({ ok: true }),
        closeMR: vi.fn().mockResolvedValue({ ok: true }),
        reopenMR: vi.fn().mockResolvedValue({ ok: true }),
        updateMR: vi.fn().mockResolvedValue({ ok: true })
      }
    }
  })

  afterEach(() => {
    if (root) {
      act(() => root?.unmount())
      root = null
    }
    document.body.replaceChildren()
  })

  it('routes runtime-owned GitHub PR merges through the runtime host', async () => {
    const { onRefreshReview } = await renderHook(makeRepo({ executionHostId: 'runtime:env-1' }))

    await act(async () => {
      await latest?.handleMerge('squash')
    })

    expect(runtimeRpcMocks.callRuntimeRpc).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'env-1' },
      'github.mergePR',
      {
        repo: 'repo-1',
        prNumber: 1015,
        method: 'squash',
        prRepo
      },
      { timeoutMs: 4 * 60_000 }
    )
    expect(window.api.gh.mergePR).not.toHaveBeenCalled()
    expect(onRefreshReview).toHaveBeenCalledTimes(1)
  })

  it('keeps non-runtime GitHub PR merges on desktop IPC', async () => {
    const { onRefreshReview } = await renderHook(
      makeRepo({ connectionId: 'ssh-target', executionHostId: 'ssh:ssh-target' })
    )

    await act(async () => {
      await latest?.handleMerge('merge')
    })

    expect(window.api.gh.mergePR).toHaveBeenCalledWith({
      repoPath: '/repo',
      repoId: 'repo-1',
      prNumber: 1015,
      method: 'merge',
      prRepo
    })
    expect(runtimeRpcMocks.callRuntimeRpc).not.toHaveBeenCalled()
    expect(onRefreshReview).toHaveBeenCalledTimes(1)
  })

  it('gates runtime-owned ready mutations on the host capability', async () => {
    const { onRefreshReview } = await renderHook(makeRepo({ executionHostId: 'runtime:env-1' }))

    await act(async () => {
      await latest?.handleMarkReadyForReview()
    })

    expect(runtimeRpcMocks.assertRuntimeEnvironmentCapability).toHaveBeenCalledWith(
      'env-1',
      'github.markPRReadyForReview',
      expect.stringContaining('newer Orca server')
    )
    expect(runtimeRpcMocks.callRuntimeRpc).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'env-1' },
      'github.markPRReadyForReview',
      { repo: 'repo-1', prNumber: 1015, prRepo },
      { timeoutMs: 30_000 }
    )
    expect(window.api.gh.markPRReadyForReview).not.toHaveBeenCalled()
    expect(onRefreshReview).toHaveBeenCalledTimes(1)
  })

  it('keeps local GitHub ready mutations on desktop IPC', async () => {
    const githubRefresh = vi.fn().mockResolvedValue(undefined)
    await renderHook(makeRepo(), githubRefresh)

    await act(async () => {
      await latest?.handleMarkReadyForReview()
    })

    expect(window.api.gh.markPRReadyForReview).toHaveBeenCalledWith({
      repoPath: '/repo',
      repoId: 'repo-1',
      prNumber: 1015,
      prRepo
    })
    expect(githubRefresh).toHaveBeenCalledTimes(1)
  })

  it('routes GitLab ready mutations through the existing update API', async () => {
    const gitLabRefresh = vi.fn().mockResolvedValue(undefined)
    await renderHook(makeRepo(), gitLabRefresh, undefined, true)
    await act(async () => {
      await latest?.handleMarkReadyForReview()
    })

    expect(window.api.gl.updateMR).toHaveBeenCalledWith({
      repoPath: '/repo',
      repoId: 'repo-1',
      iid: 1015,
      updates: { readyForReview: true }
    })
    expect(gitLabRefresh).toHaveBeenCalledTimes(1)
  })

  it('gates runtime-owned GitLab ready mutations on the host capability', async () => {
    const gitLabRefresh = vi.fn().mockResolvedValue(undefined)
    await renderHook(makeRepo({ executionHostId: 'runtime:env-1' }), gitLabRefresh, undefined, true)

    await act(async () => {
      await latest?.handleMarkReadyForReview()
    })

    expect(runtimeRpcMocks.assertRuntimeEnvironmentCapability).toHaveBeenCalledWith(
      'env-1',
      'gitlab.updateMR.readyForReview.v1',
      expect.stringContaining('newer Orca server')
    )
    expect(runtimeRpcMocks.callRuntimeRpc).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'env-1' },
      'gitlab.updateMR',
      { repo: 'repo-1', iid: 1015, updates: { readyForReview: true } },
      { timeoutMs: 30_000 }
    )
    expect(window.api.gl.updateMR).not.toHaveBeenCalled()
    expect(gitLabRefresh).toHaveBeenCalledTimes(1)
  })

  it('routes GitLab approval through the existing update API and refreshes', async () => {
    const gitLabRefresh = vi.fn().mockResolvedValue(undefined)
    await renderHook(makeRepo(), gitLabRefresh, undefined, true)

    await act(async () => {
      await latest?.handleApproval('approve')
    })

    expect(window.api.gl.updateMR).toHaveBeenCalledWith({
      repoPath: '/repo',
      repoId: 'repo-1',
      iid: 1015,
      updates: { approval: 'approve' }
    })
    expect(gitLabRefresh).toHaveBeenCalledTimes(1)
    expect(latest?.actionError).toBeNull()
    expect(latest?.approving).toBe(false)
  })

  it('shows a failed approval in the card error and still refreshes', async () => {
    const gitLabRefresh = vi.fn().mockResolvedValue(undefined)
    vi.mocked(window.api.gl.updateMR).mockResolvedValueOnce({
      ok: false,
      error: '401 Unauthorized'
    })
    await renderHook(makeRepo(), gitLabRefresh, undefined, true)

    await act(async () => {
      await latest?.handleApproval('approve')
    })

    expect(latest?.actionError).toBe('401 Unauthorized')
    // Why: a lost response or an "already approved" race must not leave the button stale.
    expect(gitLabRefresh).toHaveBeenCalledTimes(1)
  })

  it('shows a thrown approval error in the card', async () => {
    vi.mocked(window.api.gl.updateMR).mockRejectedValueOnce(new Error('network down'))
    await renderHook(makeRepo(), undefined, undefined, true)

    await act(async () => {
      await latest?.handleApproval('unapprove')
    })

    expect(latest?.actionError).toBe('network down')
  })

  it('reports approving while the request is in flight', async () => {
    let finish: (value: { ok: true }) => void = () => {}
    vi.mocked(window.api.gl.updateMR).mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve
      })
    )
    await renderHook(makeRepo(), undefined, undefined, true)

    let inFlight: Promise<void> | undefined
    await act(async () => {
      inFlight = latest?.handleApproval('approve')
    })
    expect(latest?.approving).toBe(true)

    await act(async () => {
      finish({ ok: true })
      await inFlight
    })
    expect(latest?.approving).toBe(false)
  })

  it('confirms the downstack merge scope before merging a registered stack', async () => {
    const stackedPR = {
      ...githubPR,
      stack: {
        number: 51,
        position: 2,
        size: 3,
        baseRefName: 'main',
        entries: [
          {
            position: 1,
            number: 1014,
            title: 'Models',
            url: 'https://github.com/stablyai/orca/pull/1014',
            state: 'open',
            checksStatus: 'success',
            mergeable: 'MERGEABLE'
          },
          {
            position: 2,
            number: 1015,
            title: 'API',
            url: 'https://github.com/stablyai/orca/pull/1015',
            state: 'open',
            checksStatus: 'success',
            mergeable: 'MERGEABLE'
          },
          {
            position: 3,
            number: 1016,
            title: 'UI',
            url: 'https://github.com/stablyai/orca/pull/1016',
            state: 'open',
            checksStatus: 'success',
            mergeable: 'MERGEABLE'
          }
        ]
      }
    } as PRInfo
    await renderHook(makeRepo(), undefined, stackedPR)

    await act(async () => {
      await latest?.handleMerge('squash')
    })

    expect(confirmationMocks.confirm).toHaveBeenCalledWith({
      title: 'Merge through #1015?',
      description:
        'Included: #1014, #1015. GitHub will merge 2 pull requests atomically using squash. If any cannot merge, none will.',
      confirmLabel: 'Merge 2 PRs'
    })
    expect(window.api.gh.mergePR).toHaveBeenCalledTimes(1)
  })

  it('describes merge-queue stack behavior without promising atomicity or a method', async () => {
    const stackedPR = {
      ...githubPR,
      mergeQueueRequired: true,
      stack: {
        number: 51,
        position: 2,
        size: 2,
        baseRefName: 'main',
        entries: [
          {
            position: 1,
            number: 1014,
            title: 'Models',
            url: 'https://github.com/stablyai/orca/pull/1014',
            state: 'open',
            checksStatus: 'success',
            mergeable: 'MERGEABLE'
          },
          {
            position: 2,
            number: 1015,
            title: 'API',
            url: 'https://github.com/stablyai/orca/pull/1015',
            state: 'open',
            checksStatus: 'success',
            mergeable: 'MERGEABLE'
          }
        ]
      }
    } as PRInfo
    await renderHook(makeRepo(), undefined, stackedPR)

    await act(async () => {
      await latest?.handleMerge('squash')
    })

    expect(confirmationMocks.confirm).toHaveBeenCalledWith({
      title: 'Queue through #1015?',
      description:
        'Included: #1014, #1015. GitHub will add 2 pull requests to the merge queue together. The queue chooses the merge method and may merge them in separate groups.',
      confirmLabel: 'Queue 2 PRs'
    })
  })
})
