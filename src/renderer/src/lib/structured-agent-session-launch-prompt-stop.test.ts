// @vitest-environment happy-dom
// A Stop pressed while a new chat starts, through the chat's own Stop control.

import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ call: vi.fn() }))

vi.mock('@/runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: mocks.call,
  ensureRuntimeEnvironmentCompatible: vi.fn(async () => undefined)
}))

vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: (target: unknown, method: string, params?: unknown) =>
    mocks.call(target, method, params)
}))

import {
  resetStructuredAgentSessionSendsForTests,
  stopStructuredAgentSessionSends
} from '@/components/native-chat/structured-agent-session-message-sender'
import {
  clearNativeChatDraftCacheForTests,
  readNativeChatDraftCache,
  subscribeToNativeChatDraftAppend
} from '@/components/native-chat/native-chat-draft-cache'
import { structuredAgentSessionDraftScopeKey } from '@/components/native-chat/native-chat-composer-draft-store'
import {
  getStructuredAgentSessionPendingSends,
  getStructuredAgentSessionSendNotice,
  structuredAgentSessionSendOut
} from '@/components/native-chat/structured-agent-session-pending-sends'
import { structuredAgentSessionStopControl } from '@/components/native-chat/structured-agent-session-stop-control'
import {
  discardStructuredLaunchPrompts,
  hasStagedStructuredLaunchPrompt,
  settleStructuredAgentLaunchPrompt,
  stageStructuredLaunchPrompt,
  takeBackLegacyStructuredLaunchPrompts
} from './structured-agent-session-launch-prompt'
import { newAgentPromptOutcome } from './new-agent-prompt-outcome'

const SESSION = 'session-1'
const target = { kind: 'local' } as const

function accepted(clientMessageId: string) {
  return {
    ok: true,
    replayed: false,
    fence: 1,
    cursor: { epoch: 'epoch-1', sequence: 1 },
    value: {
      clientMessageId,
      submission: {
        clientMessageId,
        fence: 1,
        payloadFingerprint: 'fingerprint',
        dispatchState: 'accepted',
        providerItemId: null,
        reason: null,
        submittedAt: 1,
        resolvedAt: null
      }
    }
  }
}

const sends = () => mocks.call.mock.calls.filter(([, method]) => method === 'agentSession.send')
const draft = () => readNativeChatDraftCache(structuredAgentSessionDraftScopeKey(SESSION))

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) {
    await Promise.resolve()
  }
}

/** A launch whose chat publishes only when the test says so. */
function launchFor(text: string, options: { callerKeepsText?: true } = {}) {
  let publish: () => void = () => {}
  const launchResult = new Promise<{ sessionId: string; fence: number }>((resolve) => {
    publish = () => resolve({ sessionId: SESSION, fence: 1 })
  })
  const settled = settleStructuredAgentLaunchPrompt({
    launchResult,
    target,
    options: { prompt: text },
    stagedPrompt: stageStructuredLaunchPrompt(SESSION, text, options)
  })
  if (!settled) {
    throw new Error('expected a delivery for an auto-submitted prompt')
  }
  return { settled, publish }
}

/** The chat's Stop while its host has not published it to this view. */
function unpublishedStop(stopSends = () => stopStructuredAgentSessionSends(SESSION)) {
  const hostStop = vi.fn(async () => null)
  const control = structuredAgentSessionStopControl({
    published: false,
    legacyLaunch: { takeBackText: () => takeBackLegacyStructuredLaunchPrompts(SESSION) },
    host: { stopsConversation: true, stop: hostStop },
    transportState: { turnId: null, isWorking: false },
    sends: {
      sending: getStructuredAgentSessionPendingSends(SESSION).some(
        (entry) => entry.phase === 'sending'
      ),
      stopSends
    }
  })
  return { control, hostStop }
}

describe('Stop before a new chat is published', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    resetStructuredAgentSessionSendsForTests()
    clearNativeChatDraftCacheForTests()
    discardStructuredLaunchPrompts(SESSION)
    mocks.call.mockImplementation(async (_target, _method, params) =>
      accepted(params.envelope.clientOperationId)
    )
  })

  it("leaves a notes launch's text with its notes, frees the chat, and never sends it", async () => {
    const launch = launchFor('note text', { callerKeepsText: true })
    const outcome = newAgentPromptOutcome({ delivery: launch.settled })
    const { control, hostStop } = unpublishedStop()

    expect(control.canStop).toBe(true)
    await control.stop()
    launch.publish()

    await expect(launch.settled).resolves.toEqual({ delivered: false, failureNotified: true })
    // Not delivered and no failure to report: the notes keep their text, with no toast.
    await expect(outcome).resolves.toEqual({ delivered: false })
    await flush()
    expect(draft()).toBe('')
    expect(sends()).toHaveLength(0)
    expect(hostStop).not.toHaveBeenCalled()
    expect(structuredAgentSessionSendOut(SESSION)).toBe(false)
    expect(hasStagedStructuredLaunchPrompt(SESSION)).toBe(false)
  })

  it("leaves a launch whose request is already out to settle from the host's answer", async () => {
    let answer: () => void = () => {}
    mocks.call.mockImplementation(
      (_target, _method, params) =>
        new Promise((resolve) => {
          answer = () => resolve(accepted(params.envelope.clientOperationId))
        })
    )
    const launch = launchFor('hi')
    launch.publish()
    await flush()
    expect(sends()).toHaveLength(1)
    const { control } = unpublishedStop()

    expect(control.canStop).toBe(true)
    await control.stop()
    expect(draft()).toBe('')

    answer()
    await expect(launch.settled).resolves.toMatchObject({ delivered: true })
    expect(draft()).toBe('')
    expect(sends()).toHaveLength(1)
  })

  // Bookkeeping never gates a Stop: a draft write that throws is reported, and the Stop goes on.
  it("still stops the chat's sends and says so when putting the text back throws", async () => {
    const report = vi.spyOn(console, 'error').mockImplementation(() => {})
    const unsubscribe = subscribeToNativeChatDraftAppend(
      structuredAgentSessionDraftScopeKey(SESSION),
      () => {
        throw new Error('draft listener failed')
      }
    )
    const launch = launchFor('hello')
    const stopSends = vi.fn(() => stopStructuredAgentSessionSends(SESSION))
    const { control } = unpublishedStop(stopSends)

    await expect(control.stop()).resolves.toBeNull()
    unsubscribe()
    launch.publish()

    expect(stopSends).toHaveBeenCalledTimes(1)
    expect(getStructuredAgentSessionSendNotice(SESSION)).toContain("Couldn't save your message.")
    expect(report).toHaveBeenCalledTimes(1)
    await expect(launch.settled).resolves.toEqual({ delivered: false, failureNotified: true })
    await flush()
    expect(sends()).toHaveLength(0)
    expect(structuredAgentSessionSendOut(SESSION)).toBe(false)
    expect(hasStagedStructuredLaunchPrompt(SESSION)).toBe(false)
    report.mockRestore()
  })
})
