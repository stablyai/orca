// @vitest-environment happy-dom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { PRInfo } from '../../../../../../shared/github/pull-request-types'
import type { Repo } from '../../../../../../shared/repo-types'
import { useHostedReviewActions, type HostedReviewActionInfo } from './use-hosted-review-actions'
import { presentGitHubPRMergeState } from '../../../github-pr-merge-state'

const confirmationMocks = vi.hoisted(() => ({
  confirm: vi.fn()
}))

const runtimeRpcMocks = vi.hoisted(() => ({
  callRuntimeRpc: vi.fn(),
  assertRuntimeEnvironmentCapability: vi.fn(),
  runtimeEnvironmentSupportsCapability: vi.fn()
}))

vi.mock('@/components/confirmation-dialog-context', () => ({
  useConfirmationDialog: () => confirmationMocks.confirm
}))

vi.mock('@/runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: runtimeRpcMocks.callRuntimeRpc,
  assertRuntimeEnvironmentCapability: runtimeRpcMocks.assertRuntimeEnvironmentCapability,
  runtimeEnvironmentSupportsCapability: runtimeRpcMocks.runtimeEnvironmentSupportsCapability
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
    autoMergeAction: props.pullRequest
      ? presentGitHubPRMergeState(props.pullRequest).autoMergeAction
      : null,
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
    runtimeRpcMocks.runtimeEnvironmentSupportsCapability.mockReset().mockResolvedValue(true)
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
    vi.restoreAllMocks()
    if (root) {
      act(() => root?.unmount())
      root = null
    }
    document.body.replaceChildren()
  })

  it('does not report a failed merge when only its follow-up read fails', async () => {
    const onRefreshReview = vi.fn().mockRejectedValue(new Error('refresh unavailable'))
    await renderHook(makeRepo(), onRefreshReview)

    await act(async () => {
      await latest?.handleMerge()
    })

    expect(onRefreshReview).toHaveBeenCalledOnce()
    expect(latest?.actionError).toBeNull()
    expect(latest?.merging).toBe(false)
  })
})
