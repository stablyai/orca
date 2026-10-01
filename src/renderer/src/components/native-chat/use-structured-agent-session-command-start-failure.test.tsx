// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionFailureFact } from '../../../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../../../shared/agent-session-failure-words'
import { agentJournalItemKey } from '../../../../shared/agent-session-journal-item-key'
import type { AgentJournalRenderItem } from '../../../../shared/agent-session-journal-types'
import { structuredAgentSessionStartFailureRowIdentity } from '../../../../shared/structured-agent-session-start-failure-row-key'

const mocks = vi.hoisted(() => ({ call: vi.fn(), toastError: vi.fn() }))
let fence = 3
let items: AgentJournalRenderItem[] = []

vi.mock('sonner', () => ({ toast: { error: mocks.toastError, message: vi.fn() } }))

vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.call
}))

vi.mock('./use-structured-agent-session-read', () => ({
  useStructuredAgentSessionRead: () => ({
    state: {
      fence,
      items,
      submissions: [],
      status: 'ready',
      error: null,
      hasOlder: false,
      handoff: null
    },
    loadingOlder: false,
    loadOlder: vi.fn()
  })
}))

vi.mock('./use-structured-agent-session-outbox', () => ({
  structuredSessionOperationId: () => 'operation-1',
  useStructuredAgentSessionOutbox: () => ({
    outbox: [],
    blockedClientMessageId: null,
    error: null,
    send: vi.fn(),
    retry: vi.fn()
  })
}))

import { i18n } from '@/i18n/i18n'
import { useStructuredAgentSession } from './use-structured-agent-session'
import { useStructuredAgentSessionMutate } from './use-structured-agent-session-mutate'

type Pane = { sessionId: string; transportEnabled: boolean }

const START_FAILED: AgentSessionFailureFact = { kind: 'startFailed' }
const RESTART_FAILED: AgentSessionFailureFact = { kind: 'restartFailed' }
const NOT_SIGNED_IN: AgentSessionFailureFact = { kind: 'notSignedIn' }

function startFailureRow(fact: AgentSessionFailureFact): AgentJournalRenderItem {
  return {
    itemId: agentJournalItemKey(structuredAgentSessionStartFailureRowIdentity('start-1')),
    revision: 1,
    sequence: 1,
    observedAt: 1,
    body: {
      kind: 'status',
      tone: 'error',
      ...agentSessionFailureWords(fact, { agentName: 'Codex', surface: 'row' })
    }
  }
}

function commandReply(
  command: 'clear' | 'compact',
  failure?: AgentSessionFailureFact
): { ok: true; replayed: false; fence: number; value: unknown } {
  const words = failure
    ? agentSessionFailureWords(failure, { agentName: 'Codex', command, surface: 'row' })
    : undefined
  return {
    ok: true,
    replayed: false,
    fence: 3,
    value: {
      command,
      state: 'completed',
      ...(words ? { error: words.text, failure: words.failure } : {})
    }
  }
}

// Holds every write open until the test answers it, so the fence can move in between.
function heldWrites(): (reply: unknown) => void {
  let answer: (value: unknown) => void = () => {}
  mocks.call.mockImplementation((_target: unknown, method: string) =>
    method === 'agentSession.conversationCommand' || method === 'agentSession.cancel'
      ? new Promise((resolve) => {
          answer = resolve
        })
      : Promise.resolve(null)
  )
  return (reply) => answer(reply)
}

function renderPane() {
  return renderHook(
    (pane: Pane) =>
      useStructuredAgentSession({
        sessionId: pane.sessionId,
        agent: 'codex',
        target: { kind: 'local' },
        isVisible: true,
        transportEnabled: pane.transportEnabled
      }),
    { initialProps: { sessionId: 'session-1', transportEnabled: true } }
  )
}

// The fence moves while the command is in flight, as a start during the command does, and then
// the command's reply lands. The reply still answers what this pane asked.
async function commandAcrossFenceMove(
  command: 'clear' | 'compact',
  reply: unknown,
  pane: Pane = { sessionId: 'session-1', transportEnabled: true },
  rowsAfterStart: AgentJournalRenderItem[] = items
): Promise<{ accepted: boolean; error: string | null }> {
  const answer = heldWrites()
  const { result, rerender } = renderPane()
  let sent: Promise<{ accepted: boolean; error: string | null }> = Promise.resolve({
    accepted: true,
    error: null
  })
  act(() => {
    sent = result.current.runConversationCommand(command)
  })
  fence = 5
  items = rowsAfterStart
  rerender(pane)
  await act(async () => {
    answer(reply)
    await sent
  })
  return sent
}

beforeEach(() => {
  vi.clearAllMocks()
  fence = 3
  items = []
})

afterEach(async () => {
  await i18n.changeLanguage('en')
})

describe('a conversation command whose reply lands after the fence moved', () => {
  it("shows, in the reader's language, why a start during the command failed", async () => {
    await i18n.changeLanguage('fr')
    // A /clear's start is its new chat's; a /compact's restarts this one.
    for (const [command, failure, error] of [
      ['clear', START_FAILED, "Codex n'a pas pu démarrer. Relancez /clear."],
      ['compact', RESTART_FAILED, "Codex n'a pas pu redémarrer. Relancez /compact."]
    ] as const) {
      fence = 3
      expect(await commandAcrossFenceMove(command, commandReply(command, failure))).toEqual({
        accepted: false,
        error
      })
    }
  })

  it('clears the draft for a /clear that completed', async () => {
    expect(await commandAcrossFenceMove('clear', commandReply('clear'))).toEqual({
      accepted: true,
      error: null
    })
  })

  it("says a /clear's failure even when an equal start row is loaded: that row is not the /clear's", async () => {
    await i18n.changeLanguage('fr')
    items = [startFailureRow(NOT_SIGNED_IN)]
    const outcome = await commandAcrossFenceMove('clear', commandReply('clear', NOT_SIGNED_IN))
    expect(outcome.accepted).toBe(false)
    expect(outcome.error).toMatch(/^Codex n'est pas connecté/)
    expect(outcome.error).toContain('/clear')
  })

  it('clears the draft for a /compact that started', async () => {
    expect(await commandAcrossFenceMove('compact', commandReply('compact'))).toEqual({
      accepted: true,
      error: null
    })
  })

  it("says nothing for a /compact whose start failed, when that start's row is loaded", async () => {
    // The row arrives with the new fence, after the command was sent.
    expect(
      await commandAcrossFenceMove('compact', commandReply('compact', RESTART_FAILED), undefined, [
        startFailureRow(RESTART_FAILED)
      ])
    ).toEqual({ accepted: false, error: null })
  })

  it("says why a /compact's start failed while its row is not loaded", async () => {
    expect(
      await commandAcrossFenceMove('compact', commandReply('compact', RESTART_FAILED))
    ).toEqual({ accepted: false, error: "Codex couldn't restart. Run /compact again." })
  })

  it("shows the host's refusal of a command that arrives after the fence moved", async () => {
    const outcome = await commandAcrossFenceMove('compact', {
      ok: false,
      refusal: {
        code: 'agent_session_conflict',
        message: 'Orca log text.',
        retryable: false
      }
    })
    expect(outcome).toEqual({ accepted: false, error: "The command didn't run." })
  })

  it('keeps the reply of a /clear that stopped the running agent: done clears the draft, failed says why', async () => {
    // A live runtime at fence 3; stopping it for the new chat moves the fence during the request.
    expect(await commandAcrossFenceMove('clear', commandReply('clear'))).toEqual({
      accepted: true,
      error: null
    })
    fence = 3
    expect(await commandAcrossFenceMove('clear', commandReply('clear', NOT_SIGNED_IN))).toEqual({
      accepted: false,
      error: expect.stringMatching(/^Codex is not signed in.*\/clear/)
    })
  })

  it('drops a reply the pane stopped waiting on: it left the chat and came back', async () => {
    const answer = heldWrites()
    const { result, rerender } = renderPane()
    let sent: Promise<{ accepted: boolean; error: string | null }> = Promise.resolve({
      accepted: true,
      error: null
    })
    act(() => {
      sent = result.current.runConversationCommand('clear')
    })
    fence = 5
    rerender({ sessionId: 'session-2', transportEnabled: true })
    rerender({ sessionId: 'session-1', transportEnabled: true })
    await act(async () => {
      answer(commandReply('clear', NOT_SIGNED_IN))
      await sent
    })
    expect(await sent).toEqual({ accepted: false, error: null })
  })

  it('drops a reply the pane stopped waiting on: a newer command replaced it', async () => {
    const answers: ((reply: unknown) => void)[] = []
    mocks.call.mockImplementation(
      () =>
        new Promise((resolve) => {
          answers.push(resolve)
        })
    )
    const stateRef: { current: { fence: number | null } } = { current: { fence: 3 } }
    const { result } = renderHook(() =>
      useStructuredAgentSessionMutate({
        sessionId: 'session-1',
        target: { kind: 'local' },
        stateRef
      })
    )
    const command = (): Promise<unknown> =>
      result.current.write('agentSession.conversationCommand', 'agentSession.conversationCommand', {
        command: 'clear'
      })
    const older = command()
    const newer = command()
    stateRef.current.fence = 5
    await act(async () => {
      answers[0](commandReply('clear', NOT_SIGNED_IN))
      answers[1](commandReply('clear'))
      await Promise.all([older, newer])
    })
    expect(await older).toEqual({ kind: 'dropped' })
    expect(await newer).toEqual({ kind: 'done', value: commandReply('clear').value })
  })

  it('drops a reply once the pane has moved to another chat or closed', async () => {
    for (const pane of [
      { sessionId: 'session-2', transportEnabled: true },
      { sessionId: 'session-1', transportEnabled: false }
    ]) {
      fence = 3
      expect(
        await commandAcrossFenceMove('clear', commandReply('clear', NOT_SIGNED_IN), pane)
      ).toEqual({ accepted: false, error: null })
    }
  })
})

describe('any other write across a fence move', () => {
  it('drops the result: it answered for the runtime this pane replaced', async () => {
    const answer = heldWrites()
    const { result, rerender } = renderPane()
    let stopped: Promise<unknown> = Promise.resolve('unset')
    act(() => {
      stopped = result.current.cancel('turn-1')
    })
    fence = 5
    rerender({ sessionId: 'session-1', transportEnabled: true })
    await act(async () => {
      answer({ ok: true, replayed: false, fence: 3, value: { cancelled: true } })
      await stopped
    })
    expect(await stopped).toBeNull()
    expect(mocks.toastError).not.toHaveBeenCalled()
  })

  it('keeps a result the same fence answers', async () => {
    const answer = heldWrites()
    const { result } = renderPane()
    let stopped: Promise<unknown> = Promise.resolve('unset')
    act(() => {
      stopped = result.current.cancel('turn-1')
    })
    await act(async () => {
      answer({ ok: true, replayed: false, fence: 3, value: { cancelled: true } })
      await stopped
    })
    expect(await stopped).toEqual({ cancelled: true })
  })
})
