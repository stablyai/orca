// @vitest-environment happy-dom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PRInfo, Repo } from '../../../../shared/types'
import { useHostedReviewActions, type HostedReviewActionInfo } from './use-hosted-review-actions'

const confirmationMocks = vi.hoisted(() => ({
  confirm: vi.fn()
}))

const runtimeRpcMocks = vi.hoisted(() => ({
  callRuntimeRpc: vi.fn()
}))

vi.mock('@/components/confirmation-dialog', () => ({
  useConfirmationDialog: () => confirmationMocks.confirm
}))

vi.mock('@/runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: runtimeRpcMocks.callRuntimeRpc
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

function HookProbe(props: { repo: Repo; onRefreshReview: () => Promise<void> }): null {
  latest = useHostedReviewActions({
    review,
    githubPR,
    repo: props.repo,
    isGitLab: false,
    shortLabel: 'PR',
    reviewLabel: 'pull request',
    defaultMergeMethod: 'squash',
    autoMergeAction: null,
    onRefreshReview: props.onRefreshReview
  })
  return null
}

async function renderHook(repo: Repo, onRefreshReview = vi.fn().mockResolvedValue(undefined)) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root?.render(createElement(HookProbe, { repo, onRefreshReview }))
  })
  return { onRefreshReview }
}

describe('useHostedReviewActions', () => {
  beforeEach(() => {
    confirmationMocks.confirm.mockReset().mockResolvedValue(true)
    runtimeRpcMocks.callRuntimeRpc.mockReset().mockResolvedValue({ ok: true })
    latest = null
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test-only window.api shim
    ;(window as any).api = {
      gh: {
        mergePR: vi.fn().mockResolvedValue({ ok: true }),
        setPRAutoMerge: vi.fn().mockResolvedValue({ ok: true }),
        updatePRState: vi.fn().mockResolvedValue({ ok: true })
      },
      gl: {
        mergeMR: vi.fn().mockResolvedValue({ ok: true }),
        closeMR: vi.fn().mockResolvedValue({ ok: true }),
        reopenMR: vi.fn().mockResolvedValue({ ok: true })
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
      { timeoutMs: 30_000 }
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
})
