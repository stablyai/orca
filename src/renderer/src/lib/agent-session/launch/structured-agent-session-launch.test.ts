// @vitest-environment happy-dom
import {
  mocks,
  launchIntent,
  publishedSnapshot,
  publishIntent,
  sends,
  composerDraft,
  flushLaunchSettlement
} from './structured-agent-session-launch.test-fixture'
import { describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import type { StructuredAgentSessionLaunchIntent } from '@/lib/launch-structured-agent-session'
import { StructuredAgentSessionCreateRefusalError } from '@/lib/agent-session/launch/structured-agent-session-launch-errors'
import { refreshLocalStructuredSessionTabs } from '@/runtime/local-structured-session-tabs-sync/inventory-refresh'
import {
  retryStructuredAgentSessionLaunch,
  startStructuredAgentLaunch
} from './structured-agent-session-launch'
import { getStructuredAgentSessionLaunchLifecycle } from './structured-agent-session-launch-registry'
import { hasStagedStructuredLaunchPrompt } from './structured-agent-session-launch-prompt'

describe('startStructuredAgentLaunch', () => {
  it('keeps the launch reserved until every coalesced prompt delivery settles', async () => {
    const worktreeId = 'wt-coalesced-prompt-reservation'
    const intent = launchIntent(worktreeId)
    let resolveLaunch!: (receipt: { sessionId: string; fence: number }) => void
    const pendingSends: ((result: unknown) => void)[] = []
    mocks.createIntent.mockReturnValue(intent)
    mocks.launch.mockImplementationOnce(() => new Promise((resolve) => (resolveLaunch = resolve)))
    publishIntent(intent)
    mocks.callRuntimeRpc.mockImplementation(
      () => new Promise((resolve) => pendingSends.push(resolve))
    )

    startStructuredAgentLaunch(worktreeId, 'codex', {
      requestId: 'double-click',
      prompt: 'second prompt'
    })
    const coalesced = startStructuredAgentLaunch(worktreeId, 'codex', {
      requestId: 'double-click',
      prompt: 'second prompt'
    })
    resolveLaunch({ sessionId: intent.sessionId, fence: 1 })
    await vi.waitFor(() => expect(mocks.callRuntimeRpc).toHaveBeenCalledOnce())

    const whileSending = startStructuredAgentLaunch(worktreeId, 'codex', {
      requestId: 'double-click',
      prompt: 'second prompt'
    })
    expect(mocks.createIntent).toHaveBeenCalledOnce()
    expect(mocks.launch).toHaveBeenCalledOnce()

    await flushLaunchSettlement()
    for (const resolve of pendingSends) {
      resolve({ ok: true, value: { submission: { dispatchState: 'accepted' } } })
    }
    for (const caller of [coalesced, whileSending]) {
      await expect(caller.promptDeliveryResult).resolves.toEqual({
        delivered: true,
        failureNotified: false
      })
    }
    expect(mocks.callRuntimeRpc).toHaveBeenCalledOnce()
  })

  // Why a resume: the host refuses a second adoption of the conversation, so a new resume re-checks.
  it('keeps an unresolved resume identity reserved until inventory reconciles it', async () => {
    const worktreeId = 'wt-still-unknown'
    const resumeFrom = { providerSessionId: 'provider-still-unknown' }
    const intent = launchIntent(worktreeId)
    mocks.createIntent.mockReturnValueOnce({ ...intent, params: { ...intent.params, resumeFrom } })
    mocks.launch.mockRejectedValue(new Error('offline'))
    vi.mocked(refreshLocalStructuredSessionTabs).mockResolvedValue([])

    startStructuredAgentLaunch(worktreeId, 'codex', { requestId: 'request-23', resumeFrom })
    await flushLaunchSettlement()

    publishIntent(intent)
    startStructuredAgentLaunch(worktreeId, 'codex', { requestId: 'request-24', resumeFrom })
    await flushLaunchSettlement()

    expect(mocks.createIntent).toHaveBeenCalledOnce()
    expect(mocks.launch).toHaveBeenCalledTimes(2)
    expect(toast.error).not.toHaveBeenCalled()
  })

  it("keeps the prompt in the chat's composer, unsent, through an unknown outcome's recovery", async () => {
    const worktreeId = 'wt-unknown-prompt-retry'
    const intent = launchIntent(worktreeId)
    mocks.createIntent.mockReturnValueOnce(intent)
    mocks.launch.mockRejectedValue(new Error('offline'))
    vi.mocked(refreshLocalStructuredSessionTabs).mockResolvedValue([])

    const first = startStructuredAgentLaunch(worktreeId, 'codex', {
      requestId: 'request-25',
      prompt: 'only once'
    })
    await expect(first.launchResult).rejects.toThrow('offline')
    expect(first.releaseCallerAfterUnknownOutcome()).toBe(true)

    publishIntent(intent)
    // The chat's own Retry re-checks it; a new start would open a new chat instead.
    expect(retryStructuredAgentSessionLaunch(worktreeId, intent.sessionId)).toBe(true)
    await flushLaunchSettlement()
    expect(getStructuredAgentSessionLaunchLifecycle(worktreeId, intent.sessionId)).toBeNull()

    expect(composerDraft(intent.sessionId)).toBe('only once')
    expect(sends()).toHaveLength(0)
  })

  it("reports a repeated request's prompt as undelivered to both callers after refusal", async () => {
    const worktreeId = 'wt-refused-coalesced-prompts'
    const intent = launchIntent(worktreeId)
    let rejectLaunch!: (error: unknown) => void
    mocks.createIntent.mockReturnValueOnce(intent)
    mocks.launch.mockImplementationOnce(
      () => new Promise((_resolve, reject) => (rejectLaunch = reject))
    )

    const first = startStructuredAgentLaunch(worktreeId, 'codex', {
      requestId: 'double-click',
      prompt: 'first prompt'
    })
    const second = startStructuredAgentLaunch(worktreeId, 'codex', {
      requestId: 'double-click',
      prompt: 'first prompt'
    })
    expect(hasStagedStructuredLaunchPrompt(intent.sessionId)).toBe(true)

    rejectLaunch(new StructuredAgentSessionCreateRefusalError('unsupported'))
    await expect(first.launchResult).rejects.toBeInstanceOf(
      StructuredAgentSessionCreateRefusalError
    )
    // Neither caller delivered; the first's prompt was handed back into the failed chat's composer.
    await expect(first.promptDeliveryResult).resolves.toEqual({
      delivered: false,
      failureNotified: true,
      inComposer: true
    })
    await expect(second.promptDeliveryResult).resolves.toEqual({
      delivered: false,
      failureNotified: true
    })
    expect(composerDraft(intent.sessionId)).toBe('first prompt')
    expect(hasStagedStructuredLaunchPrompt(intent.sessionId)).toBe(false)
  })

  it('keeps a drafted chat out of a second action that sends the same text', async () => {
    const worktreeId = 'wt-coalesced-delivery-mode'
    const drafted = launchIntent(worktreeId, 'coalesced-delivery-session')
    const sent = launchIntent(worktreeId, 'sent-delivery-session')
    mocks.createIntent.mockReturnValueOnce(drafted).mockReturnValueOnce(sent)
    mocks.launch.mockImplementation((intent: StructuredAgentSessionLaunchIntent) =>
      Promise.resolve({ sessionId: intent.sessionId, fence: 1 })
    )
    vi.mocked(refreshLocalStructuredSessionTabs).mockResolvedValue([
      publishedSnapshot(worktreeId, drafted.sessionId),
      publishedSnapshot(worktreeId, sent.sessionId)
    ])

    startStructuredAgentLaunch(worktreeId, 'codex', {
      requestId: 'continue-click',
      prompt: 'PR #1 context',
      promptDelivery: 'draft'
    })
    const other = startStructuredAgentLaunch(worktreeId, 'codex', {
      requestId: 'fix-click',
      prompt: 'PR #1 context',
      promptDelivery: 'auto-submit'
    })

    // Why: two actions are two chats, whatever their text; neither lands in the other's chat.
    expect(other.sessionId).toBe(sent.sessionId)
    await expect(other.promptDeliveryResult).resolves.toEqual({
      delivered: true,
      failureNotified: false
    })
    expect(hasStagedStructuredLaunchPrompt(drafted.sessionId)).toBe(false)
    expect(sends().map((call) => call[2])).toEqual([
      expect.objectContaining({ envelope: expect.objectContaining({ sessionId: sent.sessionId }) })
    ])
    expect(composerDraft(drafted.sessionId)).toBe('PR #1 context')
  })
})
