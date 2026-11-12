import { afterEach, describe, expect, it, vi } from 'vitest'
import { seedLegacyAgentStatusForTests } from '../legacy-agent-status-test-seed'
import { createHookListenerState } from '../listener-state'
import { PANE_KEY } from '../normalization/agent-hook-listener-test-harness'
import { normalizeHookPayload } from '../normalization/normalize-hook-payload'
import {
  applyObservedPanePermission,
  observePanePermissionBeforeHook,
  type PaneAgentCommandLineReader
} from './pane-permission-observation'

function makeBody(hookEventName: string, sessionId: string, extra: Record<string, unknown> = {}) {
  return {
    paneKey: PANE_KEY,
    payload: {
      hookEventName,
      hook_event_name: hookEventName,
      sessionId,
      session_id: sessionId,
      ...extra
    }
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('pane-permission-observation', () => {
  it('supersedes an in-flight bypass read when a bare session starts in the same pane', async () => {
    const state = createHookListenerState()
    let finishFirst!: (commandLine: string | null) => void
    let finishSecond: ((commandLine: string | null) => void) | undefined
    let callCount = 0
    const reader: PaneAgentCommandLineReader = () => {
      callCount += 1
      return new Promise((resolve) => {
        if (callCount === 1) {
          finishFirst = resolve
        } else {
          finishSecond = resolve
        }
      })
    }

    const firstStart = makeBody('SessionStart', 'sess-full')
    const secondStart = makeBody('SessionStart', 'sess-bare')
    const firstWait = observePanePermissionBeforeHook(
      state,
      reader,
      'zcode',
      firstStart,
      'production'
    )
    const secondWait = observePanePermissionBeforeHook(
      state,
      reader,
      'zcode',
      secondStart,
      'production'
    )

    finishFirst('zcode --mode yolo')
    finishSecond?.('zcode')
    await Promise.all([firstWait, secondWait])

    const stopBare = makeBody('Stop', 'sess-bare')
    await observePanePermissionBeforeHook(state, reader, 'zcode', stopBare, 'production')
    const event = applyObservedPanePermission(
      state,
      normalizeHookPayload(state, 'zcode', stopBare, 'production'),
      false
    )
    expect(event?.providerSession?.id).toBe('sess-bare')
    expect(event?.providerSession?.permissionMode).toBeUndefined()
  })

  it('bounds the hook wait on a stalled read without dropping an established bypass mode', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'performance', 'setTimeout', 'clearTimeout'] })
    const state = createHookListenerState()
    let finishSlowRead: ((commandLine: string | null) => void) | undefined
    let shouldStall = false
    const reader: PaneAgentCommandLineReader = () =>
      shouldStall
        ? new Promise((resolve) => {
            finishSlowRead = resolve
          })
        : Promise.resolve('zcode --mode yolo')

    const turnOneBody = makeBody('UserPromptSubmit', 'sess-1', { prompt: 'first' })
    await observePanePermissionBeforeHook(state, reader, 'zcode', turnOneBody, 'production')
    const turnOneEvent = applyObservedPanePermission(
      state,
      normalizeHookPayload(state, 'zcode', turnOneBody, 'production'),
      false
    )
    expect(turnOneEvent?.providerSession?.permissionMode).toBe('bypassPermissions')
    if (turnOneEvent) {
      seedLegacyAgentStatusForTests(state, turnOneEvent)
    }

    shouldStall = true
    const turnTwoBody = makeBody('UserPromptSubmit', 'sess-1', { prompt: 'second' })
    const stalledWait = observePanePermissionBeforeHook(
      state,
      reader,
      'zcode',
      turnTwoBody,
      'production'
    )
    let settledWithinBudget = false
    void stalledWait?.then(() => {
      settledWithinBudget = true
    })
    await vi.advanceTimersByTimeAsync(500)
    expect(settledWithinBudget).toBe(true)

    const turnTwoEvent = applyObservedPanePermission(
      state,
      normalizeHookPayload(state, 'zcode', turnTwoBody, 'production'),
      false
    )
    expect(turnTwoEvent?.providerSession?.permissionMode).toBe('bypassPermissions')
    if (turnTwoEvent) {
      seedLegacyAgentStatusForTests(state, turnTwoEvent)
    }

    finishSlowRead?.('zcode')
    await vi.advanceTimersByTimeAsync(0)

    const stopBody = makeBody('Stop', 'sess-1')
    expect(
      observePanePermissionBeforeHook(state, reader, 'zcode', stopBody, 'production')
    ).toBeUndefined()
    const stopEvent = applyObservedPanePermission(
      state,
      normalizeHookPayload(state, 'zcode', stopBody, 'production'),
      false
    )
    expect(stopEvent?.providerSession?.permissionMode).toBeUndefined()
  })

  it('does not apply a replacement session bypass observation to a superseded session hook', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'performance', 'setTimeout', 'clearTimeout'] })
    const state = createHookListenerState()
    let callCount = 0
    const reader: PaneAgentCommandLineReader = () => {
      callCount += 1
      return callCount === 1
        ? new Promise<string | null>(() => {})
        : Promise.resolve('zcode --mode yolo')
    }

    const bareBody = makeBody('UserPromptSubmit', 'sess-bare', { prompt: 'bare' })
    const fullBody = makeBody('UserPromptSubmit', 'sess-full', { prompt: 'full' })

    const bareWait = observePanePermissionBeforeHook(state, reader, 'zcode', bareBody, 'production')
    const fullWait = observePanePermissionBeforeHook(state, reader, 'zcode', fullBody, 'production')
    await fullWait
    await vi.advanceTimersByTimeAsync(500)
    await bareWait

    const bareEvent = applyObservedPanePermission(
      state,
      normalizeHookPayload(state, 'zcode', bareBody, 'production'),
      false
    )
    expect(bareEvent?.providerSession?.id).toBe('sess-bare')
    expect(bareEvent?.providerSession?.permissionMode).toBeUndefined()

    const fullEvent = applyObservedPanePermission(
      state,
      normalizeHookPayload(state, 'zcode', fullBody, 'production'),
      false
    )
    expect(fullEvent?.providerSession?.id).toBe('sess-full')
    expect(fullEvent?.providerSession?.permissionMode).toBe('bypassPermissions')
  })
})
