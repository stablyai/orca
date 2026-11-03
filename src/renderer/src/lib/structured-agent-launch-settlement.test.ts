import type * as LaunchErrors from '@/lib/agent-session/launch/structured-agent-session-launch-errors'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  startStructuredAgentLaunch: vi.fn(),
  cancelStructuredAgentLaunch: vi.fn()
}))

vi.mock('@/lib/agent-session/launch/structured-agent-session-launch', () => ({
  startStructuredAgentLaunch: mocks.startStructuredAgentLaunch,
  cancelStructuredAgentLaunch: mocks.cancelStructuredAgentLaunch
}))

const launchErrorMocks = vi.hoisted(() => {
  return { StructuredAgentSessionCreateRefusalError: class extends Error {} }
})

vi.mock('@/lib/agent-session/launch/structured-agent-session-launch-errors', async () => ({
  ...(await vi.importActual<typeof LaunchErrors>(
    '@/lib/agent-session/launch/structured-agent-session-launch-errors'
  )),
  ...launchErrorMocks
}))

vi.mock('@/lib/launch-structured-agent-session', () => ({
  StructuredAgentSessionCreateRefusalError:
    launchErrorMocks.StructuredAgentSessionCreateRefusalError
}))

import '@/lib/launch-structured-agent-session'
import { settleStructuredAgentLaunch } from './structured-agent-launch-settlement'

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
      { requestId: 'request-8' },
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
      { requestId: 'request-9' },
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
      settleStructuredAgentLaunch(
        'worktree-1',
        'codex',
        { requestId: 'request-10' },
        { signal: cancellation.signal }
      )
    ).resolves.toEqual({ kind: 'structured', sessionId: 'session-1' })
    expect(mocks.cancelStructuredAgentLaunch).not.toHaveBeenCalled()
    expect(cancellation.removeEventListener).toHaveBeenCalledOnce()
  })
})
