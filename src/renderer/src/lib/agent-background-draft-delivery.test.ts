import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  pasteDraftWhenAgentReady: vi.fn<(args: { onTimeout?: () => void }) => Promise<boolean>>(),
  showAutomationPromptNotSentToast: vi.fn()
}))

vi.mock('@/lib/agent-paste-draft', () => ({
  pasteDraftWhenAgentReady: mocks.pasteDraftWhenAgentReady
}))

vi.mock('@/lib/agent-background-session-timeout-toast', () => ({
  showAutomationPromptNotSentToast: mocks.showAutomationPromptNotSentToast
}))

import {
  scheduleAgentBackgroundDraft,
  subscribeAgentBackgroundDraftDelivery
} from './agent-background-draft-delivery'

function timeoutThenFail(args: { onTimeout?: () => void }): Promise<boolean> {
  args.onTimeout?.()
  return Promise.resolve(false)
}

describe('scheduleAgentBackgroundDraft', () => {
  let cleanup: () => void = () => {}
  beforeEach(() => {
    cleanup = () => {}
    vi.clearAllMocks()
    vi.useFakeTimers()
    vi.stubGlobal('window', {
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout
    })
  })

  it('notifies delivery when the first attempt lands', async () => {
    mocks.pasteDraftWhenAgentReady.mockResolvedValue(true)
    const listener = vi.fn()
    cleanup = subscribeAgentBackgroundDraftDelivery('tab-1', listener)

    scheduleAgentBackgroundDraft('tab-1', 'do the thing', 'devin')
    await vi.advanceTimersByTimeAsync(0)

    expect(mocks.pasteDraftWhenAgentReady).toHaveBeenCalledTimes(1)
    expect(listener).toHaveBeenCalledWith(true)
    expect(mocks.showAutomationPromptNotSentToast).not.toHaveBeenCalled()
  })

  it('retries a readiness timeout — nothing was written, so a second paste is safe', async () => {
    // A cold-starting TUI missing the 8s window must not lose the run's prompt.
    mocks.pasteDraftWhenAgentReady.mockImplementationOnce(timeoutThenFail).mockResolvedValue(true)
    const listener = vi.fn()
    cleanup = subscribeAgentBackgroundDraftDelivery('tab-1', listener)

    scheduleAgentBackgroundDraft('tab-1', 'do the thing', 'devin')
    await vi.advanceTimersByTimeAsync(0)
    expect(mocks.pasteDraftWhenAgentReady).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(3000)
    expect(mocks.pasteDraftWhenAgentReady).toHaveBeenCalledTimes(2)
    expect(listener).toHaveBeenCalledWith(true)
    expect(mocks.showAutomationPromptNotSentToast).not.toHaveBeenCalled()
  })

  it('gives up after the attempt budget, toasts, and reports the failure', async () => {
    mocks.pasteDraftWhenAgentReady.mockImplementation(timeoutThenFail)
    const listener = vi.fn()
    cleanup = subscribeAgentBackgroundDraftDelivery('tab-1', listener)

    scheduleAgentBackgroundDraft('tab-1', 'do the thing', 'devin')
    await vi.advanceTimersByTimeAsync(30000)

    expect(mocks.pasteDraftWhenAgentReady).toHaveBeenCalledTimes(3)
    expect(mocks.showAutomationPromptNotSentToast).toHaveBeenCalledTimes(1)
    expect(listener).toHaveBeenCalledWith(false)
  })

  afterEach(() => cleanup())

  it('still resolves the delivery verdict when a paste attempt throws', async () => {
    // An armed dispatch gate awaits this verdict — a thrown paste must not
    // strand it (the run would wait on a notification that never arrives).
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    mocks.pasteDraftWhenAgentReady.mockRejectedValue(new Error('pty write failed'))
    const listener = vi.fn()
    cleanup = subscribeAgentBackgroundDraftDelivery('tab-1', listener)

    scheduleAgentBackgroundDraft('tab-1', 'do the thing', 'devin')
    await vi.advanceTimersByTimeAsync(0)

    expect(listener).toHaveBeenCalledWith(false)
    expect(mocks.showAutomationPromptNotSentToast).toHaveBeenCalledTimes(1)
    errorSpy.mockRestore()
  })

  it('does not retry a failed write — the composer may already hold the text', async () => {
    // pasteDraftWhenAgentReady returning false WITHOUT a timeout means a paste
    // was attempted; retrying could submit the prompt twice.
    mocks.pasteDraftWhenAgentReady.mockResolvedValue(false)
    const listener = vi.fn()
    cleanup = subscribeAgentBackgroundDraftDelivery('tab-1', listener)

    scheduleAgentBackgroundDraft('tab-1', 'do the thing', 'devin')
    await vi.advanceTimersByTimeAsync(30000)

    expect(mocks.pasteDraftWhenAgentReady).toHaveBeenCalledTimes(1)
    expect(mocks.showAutomationPromptNotSentToast).toHaveBeenCalledTimes(1)
    expect(listener).toHaveBeenCalledWith(false)
  })

  it('delivers a result that landed before the subscriber arrived', async () => {
    // The dispatch handler subscribes after launch returns; delivery can
    // finish first on a fast TUI.
    mocks.pasteDraftWhenAgentReady.mockImplementation(timeoutThenFail)

    scheduleAgentBackgroundDraft('tab-1', 'do the thing', 'devin')
    await vi.advanceTimersByTimeAsync(30000)

    const listener = vi.fn()
    cleanup = subscribeAgentBackgroundDraftDelivery('tab-1', listener)
    await Promise.resolve()

    expect(listener).toHaveBeenCalledWith(false)
  })

  it('honors unsubscribing before a buffered result fires', async () => {
    mocks.pasteDraftWhenAgentReady.mockResolvedValue(true)

    scheduleAgentBackgroundDraft('tab-1', 'do the thing', 'devin')
    await vi.advanceTimersByTimeAsync(0)

    const listener = vi.fn()
    subscribeAgentBackgroundDraftDelivery('tab-1', listener)()
    await Promise.resolve()

    expect(listener).not.toHaveBeenCalled()
  })

  it('does not notify listeners of other tabs or unsubscribed listeners', async () => {
    mocks.pasteDraftWhenAgentReady.mockResolvedValue(true)
    const otherTab = vi.fn()
    const unsubscribed = vi.fn()
    cleanup = subscribeAgentBackgroundDraftDelivery('tab-2', otherTab)
    const unsubscribe = subscribeAgentBackgroundDraftDelivery('tab-1', unsubscribed)
    unsubscribe()

    scheduleAgentBackgroundDraft('tab-1', 'do the thing', 'devin')
    await vi.advanceTimersByTimeAsync(0)

    expect(otherTab).not.toHaveBeenCalled()
    expect(unsubscribed).not.toHaveBeenCalled()
  })
})
