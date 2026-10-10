// @vitest-environment happy-dom

import { act } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getRuntimeGitStatus: vi.fn(),
  getRuntimeGitUpstreamStatus: vi.fn()
}))

vi.mock('@/runtime/runtime-git-client', () => mocks)

import { useChecksPanelGitStatusEffects } from './use-checks-panel-git-status-effects'
import { deferred, flush, mountProbe, unmountProbes } from '../source-control-hook-test-harness'

const retryTimerRef = { current: null as ReturnType<typeof setTimeout> | null }
const panelContextKeyRef = { current: 'context-A' }
const setGitStatusSnapshot = vi.fn()
const setGitStatusProbeErrorContextKey = vi.fn()
const setGitStatusRefreshNonce = vi.fn()
const updateWorktreeGitIdentity = vi.fn()

function Probe({
  nonce,
  contextKey = 'context-A',
  isPanelVisible = true,
  repoConnectionId = null,
  sshConnectionStatus,
  worktreeId = 'worktree-A',
  worktreePath = '/repo'
}: {
  nonce: number
  contextKey?: string
  isPanelVisible?: boolean
  repoConnectionId?: string | null
  sshConnectionStatus?: 'connected' | 'connecting' | 'disconnected'
  worktreeId?: string
  worktreePath?: string
}): null {
  panelContextKeyRef.current = contextKey
  useChecksPanelGitStatusEffects({
    activeConnectionId: repoConnectionId,
    activeWorktreeId: worktreeId,
    activeWorktreePath: worktreePath,
    activeWorktreePushTarget: null,
    branch: 'feature',
    eligibilityHeadOidRef: { current: null },
    eligibilityRefreshNonce: 0,
    getHostedReviewCreationEligibility: vi.fn(),
    gitStatusInvalidation: 0,
    gitStatusReadyForPanelContext: false,
    gitStatusRefreshNonce: nonce,
    gitStatusSnapshotRetryTimerRef: retryTimerRef,
    hasUncommittedChanges: false,
    hostedReviewCreationRequestKey: 'eligibility-A',
    isFolder: false,
    isPanelVisible,
    linkedAzureDevOpsPR: null,
    linkedBitbucketPR: null,
    linkedGiteaPR: null,
    linkedGitLabMR: null,
    linkedPR: null,
    fallbackGitHubPRNumber: null,
    localExecutionScope: 'host',
    ownerSettings: null,
    panelContextKey: contextKey,
    panelContextKeyRef,
    remoteStatus: undefined,
    remoteStatusInvalidation: 0,
    repo: { id: 'repo-A', path: '/repo', connectionId: repoConnectionId, worktreeBaseRef: 'main' },
    repoConnectionId,
    runtimeEnvironmentId: null,
    setGitStatusProbeErrorContextKey,
    setGitStatusRefreshNonce,
    setGitStatusSnapshot,
    setHostedReviewCreationSnapshot: vi.fn(),
    sshConnectionStatus,
    updateWorktreeGitIdentity
  } as never)
  return null
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(0)
  retryTimerRef.current = null
  panelContextKeyRef.current = 'context-A'
  mocks.getRuntimeGitStatus.mockReset()
  mocks.getRuntimeGitUpstreamStatus.mockReset()
  setGitStatusSnapshot.mockReset()
  setGitStatusProbeErrorContextKey.mockReset()
  setGitStatusRefreshNonce.mockReset()
  updateWorktreeGitIdentity.mockReset()
})

afterEach(() => {
  unmountProbes()
  vi.useRealTimers()
})

describe('useChecksPanelGitStatusEffects poll runner', () => {
  it('coalesces M nonce ticks into one trailing run after the slowTaskBackoff gap', async () => {
    const first = deferred<{
      entries: never[]
      head: string
      branch: string
      upstreamStatus: { hasUpstream: boolean; ahead: number; behind: number }
    }>()
    const status = {
      entries: [],
      head: 'head-A',
      branch: 'feature',
      upstreamStatus: { hasUpstream: true, ahead: 0, behind: 0 }
    }
    mocks.getRuntimeGitStatus.mockReturnValueOnce(first.promise).mockResolvedValue(status)
    const root: Root = await mountProbe(<Probe nonce={0} />)
    expect(mocks.getRuntimeGitStatus).toHaveBeenCalledTimes(1)

    for (let tick = 1; tick <= 5; tick += 1) {
      await act(async () => {
        root.render(<Probe nonce={tick} />)
      })
    }
    expect(mocks.getRuntimeGitStatus).toHaveBeenCalledTimes(1)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000)
      first.resolve(status)
    })
    await flush()
    expect(mocks.getRuntimeGitStatus).toHaveBeenCalledTimes(1)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(9_999)
    })
    expect(mocks.getRuntimeGitStatus).toHaveBeenCalledTimes(1)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1)
    })
    expect(mocks.getRuntimeGitStatus).toHaveBeenCalledTimes(2)
  })

  it('does not carry a slow worktree backoff into the next panel context', async () => {
    const first = deferred<{
      entries: never[]
      head: string
      branch: string
      upstreamStatus: { hasUpstream: boolean; ahead: number; behind: number }
    }>()
    const status = {
      entries: [],
      head: 'head-A',
      branch: 'feature',
      upstreamStatus: { hasUpstream: true, ahead: 0, behind: 0 }
    }
    mocks.getRuntimeGitStatus.mockReturnValueOnce(first.promise).mockResolvedValue(status)
    const root: Root = await mountProbe(<Probe nonce={0} />)
    expect(mocks.getRuntimeGitStatus).toHaveBeenCalledTimes(1)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000)
      first.resolve(status)
    })
    await flush()

    await act(async () => {
      root.render(
        <Probe nonce={0} contextKey="context-B" worktreeId="worktree-B" worktreePath="/repo-b" />
      )
    })
    await flush()

    expect(mocks.getRuntimeGitStatus).toHaveBeenCalledTimes(2)
    expect(mocks.getRuntimeGitStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({ worktreeId: 'worktree-B', worktreePath: '/repo-b' }),
      { admissionTier: 'status' }
    )
  })

  it('does not carry a discarded hidden run backoff into the reopened panel', async () => {
    const first = deferred<{
      entries: never[]
      head: string
      branch: string
      upstreamStatus: { hasUpstream: boolean; ahead: number; behind: number }
    }>()
    const status = {
      entries: [],
      head: 'head-A',
      branch: 'feature',
      upstreamStatus: { hasUpstream: true, ahead: 0, behind: 0 }
    }
    mocks.getRuntimeGitStatus.mockReturnValueOnce(first.promise).mockResolvedValue(status)
    const root: Root = await mountProbe(<Probe nonce={0} />)
    expect(mocks.getRuntimeGitStatus).toHaveBeenCalledTimes(1)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000)
      root.render(<Probe nonce={0} isPanelVisible={false} />)
    })
    first.resolve(status)
    await flush()

    await act(async () => {
      root.render(<Probe nonce={0} />)
    })
    await flush()

    expect(mocks.getRuntimeGitStatus).toHaveBeenCalledTimes(2)
  })

  it('does not carry a discarded disconnected run backoff through SSH reconnect', async () => {
    const first = deferred<{
      entries: never[]
      head: string
      branch: string
      upstreamStatus: { hasUpstream: boolean; ahead: number; behind: number }
    }>()
    const status = {
      entries: [],
      head: 'head-A',
      branch: 'feature',
      upstreamStatus: { hasUpstream: true, ahead: 0, behind: 0 }
    }
    mocks.getRuntimeGitStatus.mockReturnValueOnce(first.promise).mockResolvedValue(status)
    const root: Root = await mountProbe(
      <Probe nonce={0} repoConnectionId="ssh-1" sshConnectionStatus="connected" />
    )
    expect(mocks.getRuntimeGitStatus).toHaveBeenCalledTimes(1)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000)
      root.render(<Probe nonce={0} repoConnectionId="ssh-1" sshConnectionStatus="disconnected" />)
    })
    first.resolve(status)
    await flush()

    await act(async () => {
      root.render(<Probe nonce={0} repoConnectionId="ssh-1" sshConnectionStatus="connected" />)
    })
    await flush()

    expect(mocks.getRuntimeGitStatus).toHaveBeenCalledTimes(2)
  })
})
