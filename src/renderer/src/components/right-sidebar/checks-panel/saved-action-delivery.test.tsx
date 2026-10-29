import { setLocalRuntimeCapabilitiesForTests } from '@/runtime/local-runtime-capabilities'
import { projectAgentLaunchSettings } from '../../../../../shared/agent-launch-settings'
import { clearHostAgentMenuSettingsForTests } from '@/components/settings/use-host-agent-launch-preferences'
import { useChecksPanelCommentResolution } from './use-checks-panel-comment-resolution'
import { getRuntimeAgentInventoryKey } from '@/store/slices/runtime-agent-inventory-key'
// @vitest-environment happy-dom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import type { Dispatch, RefObject, SetStateAction } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { makeWorktree } from '@/store/slices/worktrees-slice-test-fixtures'
import { getDefaultSettings } from '../../../../../shared/constants'
import type { HostedReviewInfo } from '../../../../../shared/hosted-review'
import type { PRComment } from '../../../../../shared/github/comment-types'
import type { PRInfo } from '../../../../../shared/github/pull-request-types'
import { toast } from 'sonner'
import type { PendingPRCommentAiAck } from '../pr-comments-ai-launch-ack'
import { clearPendingPRCommentAiAck, takePendingPRCommentAiAck } from '../pr-comments-ai-launch-ack'
import type { ChecksAgentComposerState } from './panel-state-types'
import { useChecksPanelAiQueue } from './use-checks-panel-ai-queue'
import { checksPanelAsyncResultKey } from '../checks-panel-async-result-key'
import { useChecksPanelReviewData } from './use-checks-panel-review-data'
import { useChecksPanelAiAcknowledgement } from './use-checks-panel-ai-acknowledgement'

const hostRpc = vi.hoisted(() => vi.fn())
vi.mock('@/runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: hostRpc,
  runtimeEnvironmentSupportsCapability: async () => true
}))
const launch = vi.hoisted(() => vi.fn())
vi.mock('@/lib/launch-agent-in-new-tab', () => ({ launchAgentInNewTab: launch }))
vi.mock('@/lib/focus-terminal-tab-surface', () => ({ focusTerminalTabSurface: vi.fn() }))
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), message: vi.fn() } }))
const original = useAppStore.getState()
afterEach(() => {
  cleanup()
  clearHostAgentMenuSettingsForTests()
  setLocalRuntimeCapabilitiesForTests(null)
  useAppStore.setState(original, true)
  clearPendingPRCommentAiAck()
  vi.clearAllMocks()
})
function deferred<T>() {
  let resolve: (value: T) => void = () => {}
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
function fixture(saved = true, paired = false) {
  setLocalRuntimeCapabilitiesForTests([])
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { gh: { onWorkItemMutated: () => () => {} } }
  })
  const settings = getDefaultSettings('/tmp/pr-31310')
  settings.sourceControlAi!.actions = saved
    ? {
        resolveComments: { agentId: 'codex', agentArgs: '', surface: 'terminal' },
        resolveConflicts: { agentId: 'codex' }
      }
    : {}
  const repo = { id: 'repo-1', path: '/repo', displayName: 'Repo', badgeColor: 'blue', addedAt: 1 }
  const worktree = makeWorktree({ id: 'repo-1::wt-1', repoId: repo.id })
  if (paired) {
    Object.assign(worktree, { hostId: 'runtime:alpha' })
  }
  const inventory = deferred<('codex' | 'claude')[]>()
  const detect = () =>
    inventory.promise.then((ids) => {
      useAppStore.setState(
        paired
          ? {
              runtimeDetectedAgentIds: { [getRuntimeAgentInventoryKey('alpha', worktree.id)]: ids }
            }
          : { localDetectedAgentIdsByContext: { host: ids } }
      )
      return ids
    })
  useAppStore.setState({
    settings,
    repos: [repo],
    worktreesByRepo: { [repo.id]: [worktree] },
    detectedAgentIds: null,
    ensureDetectedAgents: detect
  })
  if (paired) {
    settings.disabledTuiAgents = ['codex']
    hostRpc.mockResolvedValue({
      settings: projectAgentLaunchSettings({
        defaultTuiAgent: 'codex',
        disabledTuiAgents: ['claude']
      })
    })
    useAppStore.setState({
      runtimeDetectedAgentIds: { [getRuntimeAgentInventoryKey('alpha', worktree.id)]: ['codex'] },
      runtimeStatusByEnvironmentId: new Map([
        [
          'alpha',
          {
            status: {
              runtimeId: 'r1',
              capabilities: [],
              rendererGraphEpoch: 0,
              graphStatus: 'ready',
              authoritativeWindowId: null,
              liveTabCount: 0,
              liveLeafCount: 0
            },
            checkedAt: 1
          }
        ]
      ]),
      ensureRuntimeDetectedAgents: detect,
      refreshRuntimeDetectedAgents: detect
    })
  }
  const pending: RefObject<PendingPRCommentAiAck | null> = { current: null }
  const claimed: RefObject<PendingPRCommentAiAck | null> = { current: null }
  const busy = { current: false }
  const accepted = { current: false }
  const context = { current: checksPanelAsyncResultKey(repo.id, 'main', 42, null, 'head') }
  const loading = { current: false }
  const fetchPRComments = vi.fn().mockResolvedValue([])
  let comments: PRComment[] = []
  const setComments = vi.fn((value: SetStateAction<PRComment[]>) => {
    comments = typeof value === 'function' ? value(comments) : value
  })
  const isCurrentAsyncResult = (key: string) => key === context.current
  const resolveThread = vi.fn().mockResolvedValue(true)
  let composerState: ChecksAgentComposerState | null = null
  const composer = vi.fn<(value: ChecksAgentComposerState | null) => void>()
  const setAgentComposerState: Dispatch<SetStateAction<ChecksAgentComposerState | null>> = (
    value
  ) => {
    composerState = typeof value === 'function' ? value(composerState) : value
    composer(composerState)
  }
  const review: HostedReviewInfo = {
    provider: 'github',
    number: 42,
    title: 'Review',
    state: 'open',
    url: 'https://github.com/acme/repo/pull/42',
    status: 'pending',
    updatedAt: '',
    mergeable: 'CONFLICTING'
  }
  const view = renderHook(
    ({ head }) => {
      context.current = checksPanelAsyncResultKey(repo.id, 'main', 42, null, head)
      const pr: PRInfo = {
        number: 42,
        title: 'Review',
        state: 'open',
        url: '',
        checksStatus: 'pending',
        updatedAt: '',
        mergeable: 'MERGEABLE',
        headSha: head
      }
      const data = useChecksPanelReviewData({
        activeGitLabReview: null,
        branch: 'main',
        fetchPRCheckDetails: vi.fn(),
        fetchPRComments,
        gitLabProjectRefRef: { current: null },
        isCurrentAsyncResult,
        isPanelVisible: true,
        pr,
        prCacheKey: repo.id,
        prNumber: 42,
        repo,
        activeWorktree: worktree,
        setComments,
        setCommentsError: vi.fn(),
        setCommentsLoading: (value) => {
          loading.current = typeof value === 'function' ? value(loading.current) : value
        }
      })
      const ack = useChecksPanelAiAcknowledgement({
        addPRConversationComment: vi.fn(),
        addPRReviewCommentReply: vi.fn(),
        asyncResultKeyRef: context,
        claimedCommentResolutionRef: claimed,
        commentsRef: { current: [] },
        commentsSelectionClearTokenRef: { current: 0 },
        pendingCommentResolutionRef: pending,
        resolveReviewThread: resolveThread,
        setCommentResolutionAckBusyNow: (value) => {
          busy.current = value
        },
        setComments,
        setCommentsSelectionClearRequest: vi.fn(),
        commentResolutionLaunchAcceptedRef: accepted,
        fetchComments: data.fetchComments,
        fetchGitLabDetails: vi.fn()
      })
      const resolution = useChecksPanelCommentResolution({
        activeGitLabReview: null,
        activeReview: review,
        activeWorktree: worktree,
        activeWorktreeId: worktree.id,
        asyncResultKeyRef: context,
        branch: 'main',
        claimedCommentResolutionRef: claimed,
        commentResolutionAckBusy: false,
        commentsLoading: false,
        detectedAgentIds: paired ? ['codex'] : null,
        pendingCommentResolutionRef: pending,
        pr,
        prCacheKey: repo.id,
        prNumber: 42,
        repo,
        resolveReviewThread: resolveThread,
        setAgentComposerState,
        setComments,
        settings,
        sourceControlAiActionsVisible: true,
        commentResolutionLaunchAcceptedRef: accepted
      })
      const queue = useChecksPanelAiQueue({
        ...ack,
        activeConflictReview: review,
        activeReview: review,
        activeWorktree: worktree,
        activeWorktreeId: worktree.id,
        activeWorktreePath: worktree.path,
        activeConnectionId: null,
        activeSourceControlLaunchPlatform: 'linux',
        settings,
        asyncResultKeyRef: context,
        claimedCommentResolutionRef: claimed,
        commentResolutionAckBusyRef: busy,
        commentResolutionLaunchAcceptedRef: accepted,
        pendingCommentResolutionRef: pending,
        pr: null,
        prNumber: 42,
        repo,
        resolveCommentsWithAIDisabledReason: resolution.resolveCommentsWithAIDisabledReason,
        setAgentComposerState,
        sourceControlAiActionsVisible: true,
        stateRequestKey: context.current
      })
      return {
        ...queue,
        handleResolve: resolution.handleResolve,
        noEnabledAgentKnown: resolution.noEnabledAgentKnown
      }
    },
    { initialProps: { head: 'head' } }
  )
  const groups = [
    {
      kind: 'thread' as const,
      threadId: 'thread-42',
      root: {
        id: 1,
        author: 'user',
        authorAvatarUrl: '',
        body: 'fix',
        createdAt: '',
        url: '',
        threadId: 'thread-42',
        isResolved: false
      },
      replies: []
    }
  ]
  return {
    ...view,
    inventory,
    groups,
    pending,
    claimed,
    busy,
    context,
    composer,
    resolveThread,
    loading,
    fetchPRComments,
    comments: () => comments
  }
}

it('owns detection single-flight, returns failed delivery to the editor, then consumes its exact review once', async () => {
  const delivery = deferred<{ delivered: boolean; failureNotified: boolean }>()
  launch.mockReturnValue({
    surface: { kind: 'local-terminal', tabId: 'tab-1' },
    promptDeliveryResult: delivery.promise
  })
  const f = fixture(true, true)
  await act(async () => {})
  expect(f.result.current.noEnabledAgentKnown).toBe(false)
  act(() => {
    f.result.current.handleResolveCommentsWithAI(f.groups)
    f.result.current.handleResolveCommentsWithAI(f.groups)
  })
  expect(launch).not.toHaveBeenCalled()
  const payload = f.pending.current
  await act(async () => f.inventory.resolve(['codex']))
  expect(launch).toHaveBeenCalledOnce()
  expect(launch.mock.calls[0]?.[0]).toMatchObject({
    agent: 'codex',
    worktreeId: 'repo-1::wt-1',
    agentArgs: '--dangerously-bypass-approvals-and-sandbox',
    requestedSurface: 'terminal'
  })
  expect(f.claimed.current).toBe(payload)
  await act(async () => f.result.current.handleResolveConflictsWithAI())
  expect(f.claimed.current).toBe(payload)
  expect(f.resolveThread).not.toHaveBeenCalled()
  await act(async () => delivery.resolve({ delivered: false, failureNotified: true }))
  expect(f.pending.current).toBe(payload)
  const editor = f.composer.mock.calls.at(-1)?.[0]
  expect(editor?.commentResolution).toBe(payload)
  // Retry uses the editor's captured callbacks even after the panel moves to another review.
  f.context.current = 'other-review::head'
  editor?.launchContext?.onLaunchAccepted?.()
  editor?.launchContext?.onLaunched?.()
  editor?.launchContext?.onLaunched?.()
  await waitFor(() => expect(f.resolveThread).toHaveBeenCalledOnce())
  expect(f.resolveThread).toHaveBeenCalledWith(
    '/repo',
    42,
    'thread-42',
    true,
    expect.objectContaining({ repoId: 'repo-1' })
  )
  expect(takePendingPRCommentAiAck()).toBeNull()
})

it('starts conflict resolution while the original comments acknowledgement is pending', async () => {
  const provider = deferred<boolean>()
  launch.mockReturnValue({
    surface: { kind: 'local-terminal', tabId: 'tab-1' },
    promptDeliveryResult: Promise.resolve({ delivered: true, failureNotified: false })
  })
  const f = fixture()
  f.resolveThread.mockReturnValueOnce(provider.promise)
  act(() => f.result.current.handleResolveCommentsWithAI(f.groups))
  await act(async () => f.inventory.resolve(['codex']))
  await waitFor(() => expect(f.resolveThread).toHaveBeenCalledOnce())
  expect(f.busy.current).toBe(true)
  act(() => {
    f.result.current.handleResolveCommentsWithAI(f.groups)
    void f.result.current.handleResolveConflictsWithAI()
    void f.result.current.handleResolveConflictsWithAI()
  })
  await waitFor(() => expect(launch).toHaveBeenCalledTimes(2))
  expect(launch.mock.calls[1]?.[0]).toMatchObject({ launchSource: 'conflict_resolution' })
  expect(f.busy.current).toBe(true)
  await act(async () => provider.resolve(true))
  await waitFor(() => expect(f.busy.current).toBe(false))
  expect(f.resolveThread).toHaveBeenCalledOnce()
  expect(f.resolveThread).toHaveBeenCalledWith(
    '/repo',
    42,
    'thread-42',
    true,
    expect.objectContaining({ repoId: 'repo-1' })
  )
})

it.each([false, true])(
  'opens correction without substitution for no saved agent or unavailable saved agent (%s)',
  async (saved) => {
    const f = fixture(saved)
    act(() => f.result.current.handleResolveCommentsWithAI(f.groups))
    await act(async () => f.inventory.resolve(['claude']))
    await waitFor(() => expect(f.composer).toHaveBeenCalledOnce())
    expect(launch).not.toHaveBeenCalled()
    expect(f.composer.mock.calls[0]?.[0]?.launchContext?.initialRecipe?.agentId).toBe(
      saved ? 'codex' : undefined
    )
  }
)

it.each(['before-delivery', 'during-ack'])(
  'refreshes the current head after original-target acknowledgement (%s)',
  async (churn) => {
    const delivery = deferred<{ delivered: boolean; failureNotified: boolean }>()
    const provider = deferred<boolean>()
    launch.mockReturnValue({
      surface: { kind: 'local-terminal', tabId: 'tab-1' },
      promptDeliveryResult: delivery.promise
    })
    const f = fixture()
    f.resolveThread.mockReturnValueOnce(provider.promise)
    act(() => f.result.current.handleResolveCommentsWithAI(f.groups))
    await act(async () => f.inventory.resolve(['codex']))
    if (churn === 'before-delivery') {
      await act(async () => f.rerender({ head: 'head-B' }))
    }
    await act(async () => delivery.resolve({ delivered: true, failureNotified: false }))
    expect(f.resolveThread).toHaveBeenCalledOnce()
    if (churn === 'during-ack') {
      await act(async () => f.rerender({ head: 'head-B' }))
    }
    expect(f.loading.current).toBe(false)
    await act(async () => provider.resolve(true))
    await waitFor(() => expect(f.busy.current).toBe(false))
    expect(f.fetchPRComments.mock.calls.filter((call) => call[2]?.force)).toHaveLength(1)
    expect(f.loading.current).toBe(false)
    expect(f.resolveThread).toHaveBeenCalledWith(
      '/repo',
      42,
      'thread-42',
      true,
      expect.objectContaining({ repoId: 'repo-1' })
    )
    act(() => f.result.current.handleResolveCommentsWithAI(f.groups))
    await waitFor(() => expect(launch).toHaveBeenCalledTimes(2))
  }
)

it('rolls back and reports a failed resolve after the PR head moves mid-request', async () => {
  const provider = deferred<boolean>()
  const f = fixture()
  const thread = { ...f.groups[0].root, isResolved: false }
  f.fetchPRComments.mockResolvedValue([thread])
  await act(async () => f.rerender({ head: 'head' }))
  await waitFor(() => expect(f.comments()).toEqual([thread]))
  f.resolveThread.mockReturnValueOnce(provider.promise)
  let pending: Promise<boolean> = Promise.resolve(true)
  act(() => {
    pending = f.result.current.handleResolve('thread-42', true)
  })
  // The store cache already holds the optimistic resolve when the new head re-reads it.
  f.fetchPRComments.mockResolvedValue([{ ...thread, isResolved: true }])
  await act(async () => f.rerender({ head: 'head-B' }))
  await waitFor(() => expect(f.comments()[0]?.isResolved).toBe(true))
  await act(async () => {
    provider.resolve(false)
    await pending
  })
  expect(f.comments()[0]?.isResolved).toBe(false)
  expect(toast.error).toHaveBeenCalledOnce()
})
