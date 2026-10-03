// @vitest-environment happy-dom

// "Resolve comments with AI" into a structured chat hands its review writes to the launch prompt,
// whose host runs them once the agent takes the message: the panel itself writes nothing. A
// terminal agent has no message to carry them, so the panel still writes once the paste lands.

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type ReadHold = { sessionId: string; target: unknown; released: boolean }

const mocks = vi.hoisted(() => ({
  hostRunsReviewReplies: vi.fn(async () => true),
  readHolds: new Array<ReadHold>(),
  launchAgentInNewTab: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn()
}))

vi.mock('@/lib/launch-agent-in-new-tab', () => ({ launchAgentInNewTab: mocks.launchAgentInNewTab }))
vi.mock('@/lib/focus-terminal-tab-surface', () => ({ focusTerminalTabSurface: vi.fn() }))
vi.mock('@/lib/structured-agent-session-review-reply-support', () => ({
  structuredChatHostRunsReviewReplies: mocks.hostRunsReviewReplies
}))
vi.mock('@/components/native-chat/structured-agent-session-read-owner', () => ({
  getStructuredAgentSessionReadOwner: (sessionId: string, target: unknown) => ({
    activate: () => {
      const hold = { sessionId, target, released: false }
      mocks.readHolds.push(hold)
      return () => {
        hold.released = true
      }
    }
  })
}))
vi.mock('sonner', () => ({ toast: { error: mocks.toastError, success: mocks.toastSuccess } }))

import type { PRComment } from '../../../../../shared/github/comment-types'
import {
  clearPendingPRCommentAiAck,
  setPendingPRCommentAiAck,
  type PendingPRCommentAiAck
} from '../pr-comments-ai-launch-ack'
import { runSourceControlAgentActionStart } from '../runSourceControlAgentActionStart'
import { useChecksPanelAiAcknowledgement } from './use-checks-panel-ai-acknowledgement'
import { agentJournalItemKey } from '../../../../../shared/agent-session-journal-item-key'
import { agentSessionReviewReplyReceiptMessageId } from '../../../../../shared/agent-session-review-reply'
import { noticeStructuredReviewReplyReceipt } from '@/lib/structured-agent-session-review-reply-settled'

const REVIEW_KEY = 'repo-1::42::sha-1'

function comment(overrides: Partial<PRComment>): PRComment {
  return {
    id: 1,
    author: 'alice',
    authorAvatarUrl: '',
    body: 'Please update this.',
    createdAt: '2026-05-14T00:00:00Z',
    url: 'https://github.com/acme/widgets/pull/42#discussion_r1',
    ...overrides
  }
}

/** An open review thread and a conversation comment. */
function resolution(): PendingPRCommentAiAck {
  const target = { repoPath: '/repos/widgets', repoId: 'repo-1', prNumber: 42 }
  return {
    reviewContextKey: REVIEW_KEY,
    provider: 'github',
    selectedGroups: [
      {
        kind: 'thread',
        threadId: 'T1',
        root: comment({ id: 10, threadId: 'T1', path: 'src/a.ts', isResolved: false }),
        replies: []
      },
      {
        kind: 'standalone',
        comment: comment({ id: 20, url: 'https://github.com/acme/widgets/pull/42#issuecomment-9' })
      }
    ],
    githubTarget: { ...target, prRepo: { owner: 'acme', repo: 'widgets' } },
    githubResolveTarget: target
  }
}

type AcknowledgementInput = Parameters<typeof useChecksPanelAiAcknowledgement>[0]

function acknowledgement(pending: PendingPRCommentAiAck = resolution()) {
  setPendingPRCommentAiAck(pending)
  const model = {
    addPRConversationComment: vi.fn<AcknowledgementInput['addPRConversationComment']>(async () => ({
      ok: true,
      comment: comment({ id: 30 })
    })),
    addPRReviewCommentReply: vi.fn<AcknowledgementInput['addPRReviewCommentReply']>(async () => ({
      ok: true,
      comment: comment({ id: 31, threadId: 'T1' })
    })),
    resolveReviewThread: vi.fn<AcknowledgementInput['resolveReviewThread']>(async () => true),
    asyncResultKeyRef: { current: REVIEW_KEY },
    claimedCommentResolutionRef: { current: null },
    commentsRef: { current: [] },
    commentsSelectionClearTokenRef: { current: 0 },
    pendingCommentResolutionRef: { current: pending },
    commentResolutionLaunchAcceptedRef: { current: false },
    setCommentResolutionAckBusyNow: vi.fn(),
    setComments: vi.fn(),
    setCommentsSelectionClearRequest: vi.fn(),
    settings: null,
    fetchComments: vi.fn(async () => {}),
    fetchGitLabDetails: vi.fn(async () => {})
  } satisfies AcknowledgementInput
  const hook = renderHook(() => useChecksPanelAiAcknowledgement(model))
  return { model, hook }
}

function resolveCommentsWithAi(hook: ReturnType<typeof acknowledgement>['hook']) {
  return act(() =>
    runSourceControlAgentActionStart({
      selectedAgent: 'claude',
      trimmedCommandInput: 'Fix the comments',
      agentArgs: '',
      agentArgsApply: false,
      commandTemplate: '{basePrompt}',
      saveTargetValue: 'none',
      actionId: 'resolveComments',
      repoId: null,
      settings: null,
      repo: null,
      worktreeId: 'wt-1',
      groupId: 'wt-1',
      promptDelivery: 'submit-after-ready',
      launchPlatform: 'linux',
      launchSource: 'task_page',
      reviewReply: hook.result.current.buildLaunchReviewReply,
      onLaunchAccepted: hook.result.current.handleLaunchAccepted,
      onLaunchAborted: hook.result.current.handleLaunchAborted,
      onLaunched: (launch) =>
        hook.result.current.consumeClaimedCommentResolutionAfterDeliveryRef.current(launch),
      onClose
    })
  )
}

const onClose = vi.fn()
const DELIVERED = Promise.resolve({ delivered: true, failureNotified: false })
const CARRIED = Promise.resolve({
  delivered: true,
  failureNotified: false,
  reviewReplyCarried: true as const
})

describe('Resolve comments with AI', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    clearPendingPRCommentAiAck()
  })
  afterEach(() => {
    cleanup()
  })

  it('hands a structured chat its review writes and writes nothing itself', async () => {
    const { model, hook } = acknowledgement()
    mocks.launchAgentInNewTab.mockReturnValue({
      surface: { kind: 'local-agent-session', tabId: 'tab-1', sessionId: 'session-1' },
      promptDeliveryResult: CARRIED,
      structuredSettlement: Promise.resolve({ kind: 'launched' })
    })

    await expect(resolveCommentsWithAi(hook)).resolves.toBe(true)

    expect(mocks.launchAgentInNewTab).toHaveBeenCalledWith(
      expect.objectContaining({
        reviewReply: expect.objectContaining({
          provider: 'github',
          repoId: 'repo-1',
          prNumber: 42,
          resolve: ['T1'],
          conversationReply: expect.stringContaining('Fixing')
        })
      })
    )
    expect(model.resolveReviewThread).not.toHaveBeenCalled()
    expect(model.addPRConversationComment).not.toHaveBeenCalled()
    expect(model.addPRReviewCommentReply).not.toHaveBeenCalled()
    // No counts toast: the chat says it if a write fails.
    expect(mocks.toastSuccess).not.toHaveBeenCalled()
    expect(model.setCommentsSelectionClearRequest).toHaveBeenCalledOnce()
    expect(model.pendingCommentResolutionRef.current).toBeNull()
  })

  /** The chat's live stream bringing its review-reply receipt (a tombstone: all went through). */
  function receiptArrives(sessionId: string): void {
    noticeStructuredReviewReplyReceipt(sessionId, {
      type: 'batch',
      sessionId,
      batch: {
        cursor: { epoch: 'e', sequence: 9 },
        items: [],
        removedItemIds: [
          agentJournalItemKey({
            provider: 'orca',
            clientMessageId: agentSessionReviewReplyReceiptMessageId('message-1')
          })
        ],
        submissions: []
      }
    })
  }

  it('refetches the PR once the chat says its host wrote, on this host or a paired one', async () => {
    mocks.readHolds.length = 0
    const { model, hook } = acknowledgement()
    mocks.launchAgentInNewTab.mockReturnValue({
      surface: { kind: 'host-published' },
      promptDeliveryResult: CARRIED,
      structuredSettlement: Promise.resolve({ kind: 'structured', sessionId: 'paired-session' }),
      structuredChatTarget: { kind: 'environment', environmentId: 'paired-1' }
    })
    await expect(resolveCommentsWithAi(hook)).resolves.toBe(true)
    expect(model.fetchComments).not.toHaveBeenCalled()

    // While it waits, the chat's read stays open on its host, shown or not.
    expect(mocks.readHolds).toEqual([
      {
        sessionId: 'paired-session',
        target: { kind: 'environment', environmentId: 'paired-1' },
        released: false
      }
    ])

    receiptArrives('paired-session')
    receiptArrives('paired-session')

    expect(model.fetchComments).toHaveBeenCalledExactlyOnceWith({ force: true })
    expect(mocks.readHolds[0]?.released).toBe(true)
  })

  it("refetches with the panel's latest fetch after the agent pushed, and not at all on another PR", async () => {
    const { model, hook } = acknowledgement()
    mocks.launchAgentInNewTab.mockReturnValue({
      surface: { kind: 'local-agent-session', tabId: 'tab-1', sessionId: 'session-1' },
      promptDeliveryResult: CARRIED,
      structuredSettlement: Promise.resolve({ kind: 'structured', sessionId: 'session-1' }),
      structuredChatTarget: { kind: 'local' }
    })
    await expect(resolveCommentsWithAi(hook)).resolves.toBe(true)
    // The agent pushed: same PR, new head, and the panel's fetch was rebuilt for it.
    const fetchAtNewHead = vi.fn(async () => {})
    model.asyncResultKeyRef.current = 'repo-1::42::sha-2'
    model.fetchComments = fetchAtNewHead
    hook.rerender()

    receiptArrives('session-1')

    expect(fetchAtNewHead).toHaveBeenCalledExactlyOnceWith({ force: true })

    const again = acknowledgement()
    await expect(resolveCommentsWithAi(again.hook)).resolves.toBe(true)
    again.model.asyncResultKeyRef.current = 'repo-1::77::sha-9'
    again.hook.rerender()

    receiptArrives('session-1')

    expect(again.model.fetchComments).not.toHaveBeenCalled()
  })

  it('stops waiting for the receipt when the panel goes away', async () => {
    const { model, hook } = acknowledgement()
    mocks.launchAgentInNewTab.mockReturnValue({
      surface: { kind: 'local-agent-session', tabId: 'tab-1', sessionId: 'session-1' },
      promptDeliveryResult: CARRIED,
      structuredSettlement: Promise.resolve({ kind: 'structured', sessionId: 'session-1' }),
      structuredChatTarget: { kind: 'local' }
    })
    await expect(resolveCommentsWithAi(hook)).resolves.toBe(true)

    hook.unmount()
    receiptArrives('session-1')

    expect(model.fetchComments).not.toHaveBeenCalled()
  })

  it('hands the comments to a chat that still holds its unrecorded prompt, and offers no second Start', async () => {
    const { model, hook } = acknowledgement()
    mocks.launchAgentInNewTab.mockReturnValue({
      surface: { kind: 'local-agent-session', tabId: 'tab-1', sessionId: 'session-1' },
      promptDeliveryResult: Promise.resolve({
        delivered: false,
        failureNotified: false,
        heldByChat: true,
        reviewReplyCarried: true
      }),
      structuredSettlement: Promise.resolve({ kind: 'launched' })
    })

    await expect(resolveCommentsWithAi(hook)).resolves.toBe(true)

    expect(mocks.toastError).not.toHaveBeenCalled()
    expect(onClose).toHaveBeenCalledOnce()
    expect(model.resolveReviewThread).not.toHaveBeenCalled()
    expect(model.addPRConversationComment).not.toHaveBeenCalled()
    expect(model.setCommentsSelectionClearRequest).toHaveBeenCalledOnce()
    expect(model.pendingCommentResolutionRef.current).toBeNull()
  })

  it('hands the comments back when the chat holds nothing to send again', async () => {
    const { model, hook } = acknowledgement()
    mocks.launchAgentInNewTab.mockReturnValue({
      surface: { kind: 'local-agent-session', tabId: 'tab-1', sessionId: 'session-1' },
      promptDeliveryResult: Promise.resolve({ delivered: false, failureNotified: false }),
      structuredSettlement: Promise.resolve({ kind: 'launched' })
    })

    await expect(resolveCommentsWithAi(hook)).resolves.toBe(false)

    expect(mocks.toastError).toHaveBeenCalledOnce()
    expect(onClose).not.toHaveBeenCalled()
    expect(model.pendingCommentResolutionRef.current).toMatchObject({
      reviewContextKey: REVIEW_KEY
    })
  })

  it("says once, at launch, that it can't reply without the PR's repository", async () => {
    const { githubTarget: _missing, ...withoutReplyTarget } = resolution()
    const { model, hook } = acknowledgement(withoutReplyTarget)
    mocks.launchAgentInNewTab.mockReturnValue({
      surface: { kind: 'local-agent-session', tabId: 'tab-1', sessionId: 'session-1' },
      promptDeliveryResult: CARRIED,
      structuredSettlement: Promise.resolve({ kind: 'launched' })
    })

    await expect(resolveCommentsWithAi(hook)).resolves.toBe(true)

    expect(mocks.launchAgentInNewTab).toHaveBeenCalledWith(
      expect.objectContaining({
        reviewReply: expect.objectContaining({ replies: [], resolve: ['T1'] })
      })
    )
    expect(mocks.toastError).toHaveBeenCalledExactlyOnceWith(
      "Couldn't find the GitHub PR to reply on. Reply to those comments yourself."
    )
    expect(model.resolveReviewThread).not.toHaveBeenCalled()
  })

  it('writes once from the panel when the chat runs on a host that cannot carry the reply', async () => {
    mocks.hostRunsReviewReplies.mockResolvedValueOnce(false)
    const { model, hook } = acknowledgement()
    mocks.launchAgentInNewTab.mockReturnValue({
      surface: { kind: 'host-published' },
      promptDeliveryResult: DELIVERED,
      structuredSettlement: Promise.resolve({ kind: 'launched' })
    })

    await expect(resolveCommentsWithAi(hook)).resolves.toBe(true)

    expect(mocks.launchAgentInNewTab).toHaveBeenCalledWith(
      expect.not.objectContaining({ reviewReply: expect.anything() })
    )
    await vi.waitFor(() => expect(model.resolveReviewThread).toHaveBeenCalledOnce())
    expect(model.addPRConversationComment).toHaveBeenCalledOnce()
  })

  it('writes once from the panel when a paired host declined the chat and its terminal took the paste', async () => {
    const { model, hook } = acknowledgement()
    // The structured route was taken, but the host opened a terminal, whose paste carried no reply.
    mocks.launchAgentInNewTab.mockReturnValue({
      surface: { kind: 'host-published' },
      promptDeliveryResult: DELIVERED,
      structuredSettlement: Promise.resolve({ kind: 'terminal' })
    })

    await expect(resolveCommentsWithAi(hook)).resolves.toBe(true)

    expect(mocks.launchAgentInNewTab).toHaveBeenCalledWith(
      expect.objectContaining({ reviewReply: expect.anything() })
    )
    await vi.waitFor(() => expect(model.resolveReviewThread).toHaveBeenCalledOnce())
    expect(model.addPRConversationComment).toHaveBeenCalledOnce()
  })

  it('writes once from the panel when a terminal agent took the paste', async () => {
    const { model, hook } = acknowledgement()
    mocks.launchAgentInNewTab.mockReturnValue({
      surface: { kind: 'local-terminal', tabId: 'tab-1' },
      promptDeliveryResult: DELIVERED
    })

    await expect(resolveCommentsWithAi(hook)).resolves.toBe(true)

    await vi.waitFor(() => expect(model.resolveReviewThread).toHaveBeenCalledOnce())
    expect(model.addPRConversationComment).toHaveBeenCalledOnce()
    await vi.waitFor(() => expect(mocks.toastSuccess).toHaveBeenCalledOnce())
  })
})
