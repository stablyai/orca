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
import { getStructuredAgentSessionLaunchSelection } from './structured-agent-session-launch-options'

describe('startStructuredAgentLaunch', () => {
  it('keeps a Claude and a Codex launch in the same worktree apart', async () => {
    const worktreeId = 'wt-two-agents'
    mocks.launch.mockImplementation(async (intent: StructuredAgentSessionLaunchIntent) => ({
      sessionId: intent.sessionId,
      fence: 1
    }))
    vi.mocked(refreshLocalStructuredSessionTabs).mockResolvedValue([
      publishedSnapshot(worktreeId, `claude-session-${worktreeId}`),
      publishedSnapshot(worktreeId, `codex-session-${worktreeId}`)
    ])

    const claude = startStructuredAgentLaunch(worktreeId, 'claude', { requestId: 'request-7' })
    const codex = startStructuredAgentLaunch(worktreeId, 'codex', { requestId: 'request-8' })
    await flushLaunchSettlement()

    expect(mocks.createIntent).toHaveBeenNthCalledWith(
      1,
      worktreeId,
      'claude',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined
    )
    expect(mocks.createIntent).toHaveBeenNthCalledWith(
      2,
      worktreeId,
      'codex',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined
    )
    expect(mocks.launch).toHaveBeenCalledTimes(2)
    expect(vi.mocked(mocks.launch).mock.calls.map(([intent]) => intent.params.agent)).toEqual([
      'claude',
      'codex'
    ])
    expect(claude.sessionId).not.toBe(codex.sessionId)
    expect(toast.error).not.toHaveBeenCalled()
  })

  it.each(['late', 'missing', 'unavailable'] as const)(
    'uses an older host’s receipt to send while tab inventory is %s',
    async (inventory) => {
      const worktreeId = 'wt-host-frame'
      const intent = launchIntent(worktreeId, 'session-host-frame')
      intent.createMessageSupport = false
      mocks.createIntent.mockReturnValueOnce(intent)
      mocks.launch.mockResolvedValueOnce({ sessionId: intent.sessionId, fence: 1 })
      let reads = 0
      vi.mocked(refreshLocalStructuredSessionTabs).mockImplementation(async () => {
        reads += 1
        if (inventory === 'unavailable') {
          throw new Error('inventory unavailable')
        }
        return inventory === 'late' && reads > 1
          ? [publishedSnapshot(worktreeId, intent.sessionId)]
          : []
      })

      const launch = startStructuredAgentLaunch(worktreeId, 'codex', {
        requestId: 'request-10',
        prompt: 'first task',
        promptDelivery: 'submit-after-ready'
      })
      await expect(launch.promptDeliveryResult).resolves.toMatchObject({ delivered: true })

      expect(mocks.launch).toHaveBeenCalledOnce()
      expect(refreshLocalStructuredSessionTabs).not.toHaveBeenCalled()
      expect(sends()).toHaveLength(1)
      expect(sends()[0]?.[2]).toMatchObject({ envelope: { sessionId: intent.sessionId } })
    }
  )

  it("delivers a repeated request's prompt once, to both callers, after the shared launch settles", async () => {
    const worktreeId = 'wt-coalesced-prompt'
    const intent = launchIntent(worktreeId)
    let resolveLaunch: (receipt: { sessionId: string; fence: number }) => void = () => {}
    mocks.createIntent.mockReturnValueOnce(intent)
    mocks.launch.mockImplementation(
      () =>
        new Promise<{ sessionId: string; fence: number }>((resolve) => (resolveLaunch = resolve))
    )
    publishIntent(intent)

    const first = startStructuredAgentLaunch(worktreeId, 'codex', {
      requestId: 'double-click',
      prompt: 'second prompt'
    })
    const second = startStructuredAgentLaunch(worktreeId, 'codex', {
      requestId: 'double-click',
      prompt: 'second prompt'
    })

    resolveLaunch({ sessionId: intent.sessionId, fence: 1 })
    for (const caller of [first, second]) {
      await expect(caller.promptDeliveryResult).resolves.toEqual({
        delivered: true,
        failureNotified: false
      })
    }
    await flushLaunchSettlement()

    expect(second.sessionId).toBe(first.sessionId)
    expect(sends()).toHaveLength(1)

    expect(mocks.callRuntimeRpc).toHaveBeenCalledWith(
      { kind: 'local' },
      'agentSession.send',
      expect.objectContaining({
        body: expect.objectContaining({
          blocks: [{ type: 'text', text: 'second prompt' }]
        })
      })
    )
  })

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

  it('opens a new chat for a new start while an earlier outcome is unknown', async () => {
    const worktreeId = 'wt-unknown-different-prompts'
    const intent = launchIntent(worktreeId)
    mocks.createIntent.mockReturnValueOnce(intent)
    mocks.launch.mockRejectedValue(new Error('offline'))
    vi.mocked(refreshLocalStructuredSessionTabs).mockResolvedValue([])

    startStructuredAgentLaunch(worktreeId, 'codex', {
      requestId: 'request-18',
      prompt: 'first prompt'
    })
    await flushLaunchSettlement()
    const second = startStructuredAgentLaunch(worktreeId, 'codex', {
      requestId: 'request-19',
      prompt: 'second prompt'
    })
    await flushLaunchSettlement()

    expect(mocks.createIntent).toHaveBeenCalledTimes(2)
    expect(second.sessionId).not.toBe(intent.sessionId)
    await expect(second.launchResult).rejects.toThrow('offline')
    expect(composerDraft(second.sessionId)).toBe('second prompt')
    expect(composerDraft(intent.sessionId)).toBe('first prompt')
  })

  it('retries an absent unknown outcome with the exact same intent', async () => {
    const worktreeId = 'wt-same-envelope-retry'
    const intent = launchIntent(worktreeId)
    mocks.createIntent.mockReturnValueOnce(intent)
    mocks.launch
      .mockRejectedValueOnce(new Error('response lost'))
      .mockResolvedValueOnce({ sessionId: intent.sessionId, fence: 1 })
    vi.mocked(refreshLocalStructuredSessionTabs)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([publishedSnapshot(worktreeId, intent.sessionId)])

    startStructuredAgentLaunch(worktreeId, 'codex', { requestId: 'request-22' })
    await flushLaunchSettlement()

    expect(mocks.launch).toHaveBeenCalledTimes(2)
    expect(mocks.launch.mock.calls[0]?.[0]).toBe(intent)
    expect(mocks.launch.mock.calls[1]?.[0]).toBe(intent)
    expect(mocks.createIntent).toHaveBeenCalledOnce()
    expect(toast.error).not.toHaveBeenCalled()
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

  it('repairs failed tab publication on Retry with the original chat and operation', async () => {
    const worktreeId = 'wt-post-attach-unknown'
    const intent = launchIntent(worktreeId)
    intent.createMessageSupport = false
    mocks.createIntent.mockReturnValueOnce(intent)
    mocks.launch.mockRejectedValue(
      Object.assign(new Error('The chat may already exist.'), {
        code: 'agent_session_operation_unknown'
      })
    )
    vi.mocked(refreshLocalStructuredSessionTabs).mockResolvedValue([])

    const launch = startStructuredAgentLaunch(worktreeId, 'codex', { requestId: 'request-26' })

    await expect(launch.launchResult).rejects.toMatchObject({
      code: 'agent_session_operation_unknown'
    })
    expect(launch.isVisibilityUnknown()).toBe(true)
    expect(launch.releaseCallerAfterUnknownOutcome()).toBe(true)

    mocks.launch.mockResolvedValueOnce({ sessionId: intent.sessionId, fence: 1 })
    expect(retryStructuredAgentSessionLaunch(worktreeId, intent.sessionId)).toBe(true)
    await flushLaunchSettlement()

    expect(getStructuredAgentSessionLaunchLifecycle(worktreeId, intent.sessionId)).toBeNull()
    expect(mocks.launch).toHaveBeenCalledTimes(3)
    for (const [retried] of mocks.launch.mock.calls) {
      expect(retried).toBe(intent)
    }
    expect(mocks.createIntent).toHaveBeenCalledOnce()
  })

  // A paired server's create seeds from its settings at create time, which its probe reports.
  it("shows the seed a paired server's probe reports on a retry, not the first admission's", async () => {
    const worktreeId = 'wt-paired-retry-seed'
    const intent: StructuredAgentSessionLaunchIntent = {
      ...launchIntent(worktreeId, 'session-paired-retry-seed'),
      executionHostId: 'runtime:server-1',
      target: { kind: 'environment', environmentId: 'server-1' },
      seedOptions: { model: 'gpt-5.5' }
    }
    mocks.createIntent.mockReturnValueOnce(intent)
    mocks.launch
      .mockRejectedValueOnce(new StructuredAgentSessionCreateRefusalError('unsupported'))
      .mockImplementationOnce(
        (_intent: StructuredAgentSessionLaunchIntent, onHostSeed?: (seed: unknown) => void) => {
          onHostSeed?.({ model: 'gpt-5.6-luna' })
          return new Promise(() => undefined)
        }
      )

    startStructuredAgentLaunch(worktreeId, 'codex', { requestId: 'request-28' })
    await flushLaunchSettlement()
    expect(getStructuredAgentSessionLaunchSelection(intent.sessionId)?.seed).toEqual({
      model: 'gpt-5.5'
    })

    expect(retryStructuredAgentSessionLaunch(worktreeId, intent.sessionId)).toBe(true)
    await flushLaunchSettlement()
    expect(getStructuredAgentSessionLaunchSelection(intent.sessionId)?.seed).toEqual({
      model: 'gpt-5.6-luna'
    })
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
