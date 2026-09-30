import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  startStructuredAgentLaunch: vi.fn(),
  cancelStructuredAgentLaunch: vi.fn()
}))

vi.mock('@/lib/structured-agent-session-launch', () => ({
  startStructuredAgentLaunch: mocks.startStructuredAgentLaunch,
  cancelStructuredAgentLaunch: mocks.cancelStructuredAgentLaunch
}))

vi.mock('@/lib/launch-structured-agent-session', () => ({
  StructuredAgentSessionCreateRefusalError: class extends Error {}
}))

import { StructuredAgentSessionCreateRefusalError } from '@/lib/launch-structured-agent-session'
import {
  beginStructuredAgentLaunchSettlement,
  settleStructuredAgentLaunch
} from './structured-agent-launch-settlement'

type FakeLaunch = {
  launchResult: Promise<unknown>
  visibilityUnknown?: boolean
  promptDeliveryResult?: Promise<{ delivered: boolean; failureNotified: boolean }>
}

function fakeLaunch(args: FakeLaunch) {
  const releaseCallerAfterUnknownOutcome = vi.fn(() => true)
  mocks.startStructuredAgentLaunch.mockReturnValue({
    sessionId: 'session-1',
    launchResult: args.launchResult,
    ...(args.promptDeliveryResult ? { promptDeliveryResult: args.promptDeliveryResult } : {}),
    isVisibilityUnknown: () => args.visibilityUnknown === true,
    releaseCallerAfterUnknownOutcome
  })
  return { releaseCallerAfterUnknownOutcome }
}

/** A caller-side cancel signal: `fire` is what the caller's store subscription would abort on. */
function fakeCancellation(initiallyCancelled = false) {
  const controller = new AbortController()
  if (initiallyCancelled) {
    controller.abort()
  }
  const removeEventListener = vi.spyOn(controller.signal, 'removeEventListener')
  return {
    /** The loop must drop its listener on settle, not leave the signal holding the closure. */
    removeEventListener,
    fire: () => controller.abort(),
    signal: controller.signal
  }
}

describe('settleStructuredAgentLaunch', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns structured and activates once the launch is published', async () => {
    const promptDeliveryResult = Promise.resolve({ delivered: true, failureNotified: false })
    fakeLaunch({
      launchResult: Promise.resolve({ sessionId: 'session-1', fence: 1 }),
      promptDeliveryResult
    })
    const onStructuredReady = vi.fn()

    await expect(
      settleStructuredAgentLaunch('worktree-1', 'codex', { prompt: 'Fix' }, { onStructuredReady })
    ).resolves.toEqual({ kind: 'structured', sessionId: 'session-1', promptDeliveryResult })
    expect(mocks.startStructuredAgentLaunch).toHaveBeenCalledWith('worktree-1', 'codex', {
      prompt: 'Fix'
    })
    expect(onStructuredReady).toHaveBeenCalledWith('session-1')
  })

  it('returns the session identity before the launch settles', async () => {
    let resolveLaunch!: (receipt: { sessionId: string; fence: number }) => void
    fakeLaunch({
      launchResult: new Promise((resolve) => {
        resolveLaunch = resolve
      })
    })

    const handle = beginStructuredAgentLaunchSettlement('worktree-1', 'codex', {}, {})

    expect(handle.sessionId).toBe('session-1')
    resolveLaunch({ sessionId: 'session-1', fence: 1 })
    await expect(handle.settlement).resolves.toEqual({
      kind: 'structured',
      sessionId: 'session-1'
    })
  })

  it('keeps a structured refusal on the structured failure path', async () => {
    const error = new StructuredAgentSessionCreateRefusalError('unsupported')
    fakeLaunch({ launchResult: Promise.reject(error) })

    await expect(settleStructuredAgentLaunch('worktree-1', 'codex', {}, {})).resolves.toEqual({
      kind: 'failed',
      error
    })
  })

  it('reports an unknown outcome, releases the caller, and never runs the fallback', async () => {
    const { releaseCallerAfterUnknownOutcome } = fakeLaunch({
      launchResult: Promise.reject(new Error('connection lost')),
      visibilityUnknown: true
    })

    await expect(settleStructuredAgentLaunch('worktree-1', 'codex', {}, {})).resolves.toEqual({
      kind: 'visibility-unknown',
      sessionId: 'session-1'
    })
    expect(releaseCallerAfterUnknownOutcome).toHaveBeenCalledOnce()
  })

  it('fails a non-refusal error whose outcome is known', async () => {
    const error = new Error('boom')
    const { releaseCallerAfterUnknownOutcome } = fakeLaunch({ launchResult: Promise.reject(error) })

    await expect(settleStructuredAgentLaunch('worktree-1', 'codex', {}, {})).resolves.toEqual({
      kind: 'failed',
      error
    })
    expect(releaseCallerAfterUnknownOutcome).not.toHaveBeenCalled()
  })

  it('returns cancelled after a successful launch without activating', async () => {
    fakeLaunch({ launchResult: Promise.resolve({ sessionId: 'session-1', fence: 1 }) })
    const onStructuredReady = vi.fn()

    await expect(
      settleStructuredAgentLaunch(
        'worktree-1',
        'codex',
        {},
        {
          onStructuredReady,
          signal: fakeCancellation(true).signal
        }
      )
    ).resolves.toEqual({ kind: 'cancelled', sessionId: 'session-1' })
    expect(onStructuredReady).not.toHaveBeenCalled()
  })

  it('lets cancellation win over a refusal', async () => {
    fakeLaunch({
      launchResult: Promise.reject(new StructuredAgentSessionCreateRefusalError('unsupported'))
    })
    await expect(
      settleStructuredAgentLaunch(
        'worktree-1',
        'codex',
        {},
        {
          signal: fakeCancellation(true).signal
        }
      )
    ).resolves.toEqual({ kind: 'cancelled', sessionId: 'session-1' })
  })

  it('cancels the launch eagerly, once, before the launch settles', async () => {
    let resolveLaunch!: (receipt: { sessionId: string; fence: number }) => void
    fakeLaunch({
      launchResult: new Promise((resolve) => {
        resolveLaunch = resolve
      })
    })
    const cancellation = fakeCancellation()
    const onStructuredReady = vi.fn()

    const settlement = settleStructuredAgentLaunch(
      'worktree-1',
      'codex',
      {},
      { onStructuredReady, signal: cancellation.signal }
    )
    expect(mocks.cancelStructuredAgentLaunch).not.toHaveBeenCalled()
    cancellation.fire()
    cancellation.fire()
    expect(mocks.cancelStructuredAgentLaunch).toHaveBeenCalledExactlyOnceWith(
      'worktree-1',
      'session-1'
    )
    expect(cancellation.removeEventListener).not.toHaveBeenCalled()

    resolveLaunch({ sessionId: 'session-1', fence: 1 })
    await expect(settlement).resolves.toEqual({ kind: 'cancelled', sessionId: 'session-1' })
    expect(onStructuredReady).not.toHaveBeenCalled()
    expect(cancellation.removeEventListener).toHaveBeenCalledOnce()
  })

  it('honours a cancellation that fired before the loop subscribed', async () => {
    fakeLaunch({ launchResult: Promise.resolve({ sessionId: 'session-1', fence: 1 }) })
    const cancellation = fakeCancellation(true)

    const settlement = settleStructuredAgentLaunch(
      'worktree-1',
      'codex',
      {},
      { signal: cancellation.signal }
    )
    expect(mocks.cancelStructuredAgentLaunch).toHaveBeenCalledExactlyOnceWith(
      'worktree-1',
      'session-1'
    )
    await expect(settlement).resolves.toEqual({ kind: 'cancelled', sessionId: 'session-1' })
    expect(cancellation.removeEventListener).toHaveBeenCalledOnce()
  })

  it('unsubscribes from the cancel signal once a launch settles without cancelling', async () => {
    fakeLaunch({ launchResult: Promise.resolve({ sessionId: 'session-1', fence: 1 }) })
    const cancellation = fakeCancellation()

    await expect(
      settleStructuredAgentLaunch('worktree-1', 'codex', {}, { signal: cancellation.signal })
    ).resolves.toEqual({ kind: 'structured', sessionId: 'session-1' })
    expect(mocks.cancelStructuredAgentLaunch).not.toHaveBeenCalled()
    expect(cancellation.removeEventListener).toHaveBeenCalledOnce()
  })
})
