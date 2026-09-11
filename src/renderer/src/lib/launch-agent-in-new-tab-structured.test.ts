import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  StructuredAgentLaunchHooks,
  StructuredAgentLaunchSettlement
} from './structured-agent-launch-settlement'

const mocks = vi.hoisted(() => ({
  settleStructuredAgentLaunch: vi.fn()
}))

vi.mock('@/lib/structured-agent-launch-settlement', () => ({
  settleStructuredAgentLaunch: mocks.settleStructuredAgentLaunch
}))

import { adoptAgentSessionLaunchVerdict } from './agent-session-launch-plan'
import { launchAgentInStructuredNewTab } from './launch-agent-in-new-tab-structured'

type Delivery = 'auto-submit' | 'submit-after-ready' | 'draft'
const structuredPlan = (prompt: string, promptDelivery: Delivery, onPromptDelivered?: () => void) =>
  adoptAgentSessionLaunchVerdict({
    route: 'structured-native-chat',
    agent: 'codex',
    worktreeId: 'wt-1',
    prompt,
    promptDelivery,
    ...(onPromptDelivered ? { onPromptDelivered } : {})
  })

const delivered = { delivered: true, failureNotified: false }
const undelivered = { delivered: false, failureNotified: true }

/** Mirrors the shared loop: a refusal runs the caller's fallback once and settles with its result. */
function settleWith(settlement: StructuredAgentLaunchSettlement | 'refusal') {
  mocks.settleStructuredAgentLaunch.mockImplementation(
    async (
      _worktreeId: string,
      _agent: string,
      _options: unknown,
      hooks: StructuredAgentLaunchHooks
    ) => {
      if (settlement !== 'refusal') {
        return settlement
      }
      const fallback = await hooks.legacyFallback?.()
      return fallback
        ? { kind: 'refused-then-legacy', ...fallback }
        : { kind: 'failed', error: null }
    }
  )
}

describe('launchAgentInStructuredNewTab', () => {
  let consoleError: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    consoleError.mockRestore()
  })

  it('hands the launch to the shared settle loop and follows the structured delivery', async () => {
    const promptDeliveryResult = Promise.resolve(delivered)
    settleWith({ kind: 'structured', sessionId: 'session-1', promptDeliveryResult })
    const legacyLaunch = vi.fn()
    const onPromptDelivered = vi.fn()

    const result = launchAgentInStructuredNewTab({
      plan: structuredPlan('Fix it', 'submit-after-ready', onPromptDelivered),
      legacyLaunch
    })

    expect(mocks.settleStructuredAgentLaunch).toHaveBeenCalledWith(
      'wt-1',
      'codex',
      { prompt: 'Fix it', promptDelivery: 'submit-after-ready', onPromptDelivered },
      expect.objectContaining({ legacyFallback: expect.any(Function) })
    )
    await expect(result.structuredSettlement).resolves.toEqual({
      kind: 'structured',
      sessionId: 'session-1',
      promptDeliveryResult
    })
    await expect(result.promptDeliveryResult).resolves.toEqual(delivered)
    expect(legacyLaunch).not.toHaveBeenCalled()
    expect(consoleError).not.toHaveBeenCalled()
  })

  it('runs the terminal launch exactly once on refusal and reports its delivery', async () => {
    settleWith('refusal')
    const legacyDelivery = Promise.resolve(delivered)
    const legacyLaunch = vi.fn(() => ({
      tabId: 'tab-1',
      startupPlan: {} as never,
      pasteDraftAfterLaunch: true,
      promptDeliveryResult: legacyDelivery
    }))

    const result = launchAgentInStructuredNewTab({
      plan: structuredPlan('Fix it', 'submit-after-ready'),
      legacyLaunch
    })

    await expect(result.structuredSettlement).resolves.toEqual({
      kind: 'refused-then-legacy',
      primaryTabId: 'tab-1',
      promptDeliveryResult: legacyDelivery
    })
    await expect(result.promptDeliveryResult).resolves.toBe(delivered)
    expect(legacyLaunch).toHaveBeenCalledOnce()
  })

  it('counts an argv-carried prompt as delivered when the terminal launch returns no promise', async () => {
    settleWith('refusal')
    const legacyLaunch = vi.fn(() => ({
      tabId: 'tab-1',
      startupPlan: {} as never,
      pasteDraftAfterLaunch: false
    }))

    const result = launchAgentInStructuredNewTab({
      plan: structuredPlan('Fix it', 'auto-submit'),
      legacyLaunch
    })

    await expect(result.promptDeliveryResult).resolves.toEqual(delivered)
    await expect(result.structuredSettlement).resolves.toMatchObject({ primaryTabId: 'tab-1' })
  })

  it('reports a notified failure when the terminal launch has no startup plan', async () => {
    settleWith('refusal')

    const result = launchAgentInStructuredNewTab({
      plan: structuredPlan('Fix it', 'auto-submit'),
      legacyLaunch: () => null
    })

    await expect(result.promptDeliveryResult).resolves.toEqual(undelivered)
    await expect(result.structuredSettlement).resolves.toMatchObject({
      kind: 'refused-then-legacy',
      primaryTabId: null
    })
  })

  it('logs a failed settlement without re-entering the terminal launch', async () => {
    const error = new Error('boom')
    settleWith({ kind: 'failed', error })
    const legacyLaunch = vi.fn()

    const result = launchAgentInStructuredNewTab({
      plan: structuredPlan('Fix it', 'submit-after-ready'),
      legacyLaunch
    })

    await expect(result.structuredSettlement).resolves.toEqual({ kind: 'failed', error })
    await expect(result.promptDeliveryResult).resolves.toEqual(undelivered)
    expect(consoleError).toHaveBeenCalledWith('Structured agent launch failed', error)
    expect(legacyLaunch).not.toHaveBeenCalled()
  })

  it('treats a thrown settle loop as a failed settlement', async () => {
    const error = new Error('intent unavailable')
    mocks.settleStructuredAgentLaunch.mockRejectedValue(error)

    const result = launchAgentInStructuredNewTab({
      plan: structuredPlan('Fix it', 'submit-after-ready'),
      legacyLaunch: vi.fn()
    })

    await expect(result.structuredSettlement).resolves.toEqual({ kind: 'failed', error })
    await expect(result.promptDeliveryResult).resolves.toEqual(undelivered)
    expect(consoleError).toHaveBeenCalledWith('Structured agent launch failed', error)
  })

  it('surfaces an unknown outcome silently and never falls back', async () => {
    settleWith({ kind: 'visibility-unknown', sessionId: 'session-1' })
    const legacyLaunch = vi.fn()

    const result = launchAgentInStructuredNewTab({
      plan: structuredPlan('Fix it', 'submit-after-ready'),
      legacyLaunch
    })

    await expect(result.structuredSettlement).resolves.toEqual({
      kind: 'visibility-unknown',
      sessionId: 'session-1'
    })
    await expect(result.promptDeliveryResult).resolves.toEqual(undelivered)
    expect(consoleError).not.toHaveBeenCalled()
    expect(legacyLaunch).not.toHaveBeenCalled()
  })

  it.each([
    ['no prompt', '', 'auto-submit' as const],
    ['a draft prompt', 'Fix it', 'draft' as const]
  ])('exposes no delivery promise for %s', async (_label, prompt, promptDelivery) => {
    settleWith({ kind: 'structured', sessionId: 'session-1' })

    const result = launchAgentInStructuredNewTab({
      plan: structuredPlan(prompt, promptDelivery),
      legacyLaunch: vi.fn()
    })

    expect(result.promptDeliveryResult).toBeUndefined()
    await expect(result.structuredSettlement).resolves.toMatchObject({ kind: 'structured' })
  })
})
