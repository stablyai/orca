import { beforeEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const launch: { lifecycle: string | null } = { lifecycle: null }
  return {
    send: vi.fn(),
    relaunch: vi.fn((): Promise<{ delivered: boolean; unconfirmed?: true }> | null => null),
    launch
  }
})

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({
      unifiedTabsByWorktree: {
        'wt-1': [{ contentType: 'agent-session', entityId: 'session-1' }]
      }
    })
  }
}))
vi.mock('@/runtime/structured-agent-session-owner', () => ({
  structuredAgentSessionTargetForTab: () => ({ kind: 'local' })
}))
vi.mock('./structured-agent-session-launch-message', () => ({
  relaunchFailedStructuredAgentSessionWithMessage: mocks.relaunch
}))
vi.mock('./structured-agent-session-launch-registry', () => ({
  getStructuredAgentSessionLaunchLifecycle: () => mocks.launch.lifecycle
}))
vi.mock('./active-agent-note-send', () => ({ sendNotesToActiveAgentSession: vi.fn() }))
vi.mock('@/components/native-chat/structured-agent-session-message-sender', () => ({
  sendStructuredAgentSessionMessage: mocks.send
}))

import { sendMessageToAgent } from './agent-message-send'
import { activeAgentNotesSendFailureMessage } from './active-agent-note-send-result'

function sendNotes() {
  return sendMessageToAgent({
    worktreeId: 'wt-1',
    target: { kind: 'structured-session', sessionId: 'session-1' },
    prompt: 'the notes'
  })
}

beforeEach(() => {
  mocks.send.mockReset()
  mocks.relaunch.mockClear()
  mocks.launch.lifecycle = null
})

// Notes clear only when their message is recorded; any other end keeps them with the caller.
it.each([
  ['recorded', { status: 'sent' }],
  ['returned', { status: 'not-writable', code: 'session-send-refused' }],
  // The host may hold it: the notes stay, worded as unconfirmed, never as refused.
  ['unconfirmed', { status: 'unconfirmed', code: 'runtime-unverifiable' }],
  ['dropped', { status: 'not-writable', code: 'session-send-refused' }]
] as const)('reports notes whose message was %s', async (outcome, result) => {
  mocks.send.mockReturnValue({ clientMessageId: 'm', outcome: Promise.resolve(outcome) })
  await expect(sendNotes()).resolves.toEqual(result)
  expect(mocks.send).toHaveBeenCalledWith(
    expect.objectContaining({ sessionId: 'session-1', text: 'the notes', callerKeepsText: true })
  )
})

it('words unconfirmed notes as the chat does', () => {
  expect(activeAgentNotesSendFailureMessage('unconfirmed', { explicitTarget: true })).toBe(
    "Orca couldn't confirm your message reached the agent. Check the chat, then send it again if needed."
  )
})

it('keeps the notes while the chat has a send out', async () => {
  mocks.send.mockReturnValue(null)
  await expect(sendNotes()).resolves.toEqual({
    status: 'not-ready',
    code: 'session-send-refused'
  })
})

it.each(['pending', 'visibility-unknown'])(
  'keeps the notes while the chat is %s',
  async (lifecycle) => {
    mocks.launch.lifecycle = lifecycle
    await expect(sendNotes()).resolves.toEqual({
      status: 'not-ready',
      code: 'session-send-refused'
    })
    expect(mocks.send).not.toHaveBeenCalled()
  }
)

// The notes ride the restart of a chat whose start failed, and stay with their sender meanwhile.
it('restarts a failed chat with the notes as its first message', async () => {
  mocks.launch.lifecycle = 'failed'
  mocks.relaunch.mockReturnValue(Promise.resolve({ delivered: true }))
  await expect(sendNotes()).resolves.toEqual({ status: 'sent' })
  expect(mocks.relaunch).toHaveBeenCalledWith('wt-1', 'session-1', 'the notes', {
    callerKeepsText: true
  })
  expect(mocks.send).not.toHaveBeenCalled()
})

it('says a restart that carried the notes could not be confirmed, never that it refused them', async () => {
  mocks.launch.lifecycle = 'failed'
  mocks.relaunch.mockReturnValue(Promise.resolve({ delivered: false, unconfirmed: true }))
  await expect(sendNotes()).resolves.toEqual({
    status: 'unconfirmed',
    code: 'runtime-unverifiable'
  })
})
