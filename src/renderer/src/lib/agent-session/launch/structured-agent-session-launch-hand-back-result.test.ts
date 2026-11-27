import { beforeEach, expect, it, vi } from 'vitest'
import type * as HandBack from '@/components/native-chat/session/structured/delivery/structured-agent-session-message-hand-back'
import type * as SendAttempt from '@/components/native-chat/session/structured/delivery/structured-agent-session-send-attempt'

// The draft write and the host attempt are the stand-ins: staging, reservations, the direct and the
// reserved send, settlement and the public launch result run for real. The draft write leaves the
// returned input durable (journaled), installed (in the draft, not yet saved) or lost (it throws).
type Custody = 'durable' | 'installed' | 'lost'
const draft = vi.hoisted(() => ({ mode: 'durable' as Custody, writes: [] as string[] }))
vi.mock(
  '@/components/native-chat/session/structured/delivery/structured-agent-session-message-hand-back',
  async (importOriginal) => ({
    ...(await importOriginal<typeof HandBack>()),
    handBackStructuredAgentSessionMessage: (sessionId: string) => {
      draft.writes.push(sessionId)
      if (draft.mode === 'lost') {
        throw new Error('draft write threw')
      }
      return draft.mode === 'durable'
    }
  })
)

// Every attempt is refused before the host takes it, so its message comes back.
const attempts = vi.hoisted(() => ({ count: 0 }))
vi.mock(
  '@/components/native-chat/session/structured/delivery/structured-agent-session-send-attempt',
  async (importOriginal) => ({
    ...(await importOriginal<typeof SendAttempt>()),
    attemptStructuredAgentSessionSend: async () => {
      attempts.count += 1
      return { kind: 'not-sent', parts: ['unreachable'] }
    }
  })
)

const { stageStructuredLaunchPrompt } = await import('./structured-agent-session-staged-prompt')
const { settleStructuredAgentLaunchPrompt } =
  await import('./structured-agent-session-launch-prompt')
const { newAgentPromptOutcome } = await import('./prompt/new-agent-prompt-outcome')
const { reserveStructuredAgentSessionSend, resetStructuredAgentSessionSendsForTests } =
  await import('@/components/native-chat/session/structured/delivery/structured-agent-session-message-sender')
const { getStructuredAgentSessionSendNotice } =
  await import('@/components/native-chat/session/structured/delivery/structured-agent-session-pending-sends')

const target = { kind: 'local' } as const

beforeEach(() => {
  draft.mode = 'durable'
  draft.writes.length = 0
  attempts.count = 0
  resetStructuredAgentSessionSendsForTests()
})

/** A launch prompt staged while another send held the chat, so it has no reservation of its own. */
function stagedWithoutSlot(sessionId: string, options: { callerKeepsText?: true } = {}) {
  const other = reserveStructuredAgentSessionSend({ sessionId, text: 'already sending' })!
  const prompt = stageStructuredLaunchPrompt(sessionId, 'launch text', options)
  expect(prompt.slot).toBeNull()
  // The other send ends before the chat exists: the launch's send then takes the direct path.
  other.release()
  return prompt
}

const launch = (sessionId: string, prompt: ReturnType<typeof stageStructuredLaunchPrompt>) =>
  settleStructuredAgentLaunchPrompt({
    launchResult: Promise.resolve({ sessionId, fence: 1 }),
    target,
    options: { prompt: 'launch text' },
    stagedPrompt: prompt
  })!

// D12-01 / C16-02. Each path reports what its own hand-back left: only a durable one says the draft
// holds the message, so the caller keeps its copy otherwise. An installed one still ends the operation;
// a lost one ends nothing for custody, and the chat says the message wasn't saved.
it.each([
  ['durable', { inComposer: true, handBackFinished: true }, true],
  ['installed', { inComposer: undefined, handBackFinished: true }, false],
  ['lost', { inComposer: undefined, handBackFinished: undefined }, false]
] as const)(
  'a direct post-create send reports a %s hand-back truthfully',
  async (mode, expected, callerRetires) => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {})
    const sessionId = `direct-${mode}`
    const prompt = stagedWithoutSlot(sessionId)
    draft.mode = mode

    const result = await launch(sessionId, prompt)

    expect(attempts.count).toBe(1)
    expect(draft.writes).toEqual([sessionId])
    expect(result.delivered).toBe(false)
    expect(result.inComposer).toBe(expected.inComposer)
    expect(result.handBackFinished).toBe(expected.handBackFinished)
    // The caller (notes, a fork's question) retires its copy only on that claim.
    expect((await newAgentPromptOutcome({ delivery: Promise.resolve(result) })).delivered).toBe(
      callerRetires
    )
    expect((getStructuredAgentSessionSendNotice(sessionId) ?? '').includes("Couldn't save")).toBe(
      mode === 'lost'
    )
    quiet.mockRestore()
  }
)

// The reserved path reports the same, from the same send.
it.each([
  ['durable', true],
  ['installed', undefined],
  ['lost', undefined]
] as const)(
  'a reserved post-create send reports a %s hand-back truthfully',
  async (mode, inComposer) => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {})
    const sessionId = `reserved-${mode}`
    const prompt = stageStructuredLaunchPrompt(sessionId, 'launch text')
    expect(prompt.slot).not.toBeNull()
    draft.mode = mode

    const result = await launch(sessionId, prompt)

    expect(attempts.count).toBe(1)
    expect(draft.writes).toEqual([sessionId])
    expect(result.inComposer).toBe(inComposer)
    quiet.mockRestore()
  }
)

// C16-03. A caller-kept prompt (notes) that comes back by the direct path stays with its caller: no
// chat draft write, no claim the chat holds it, one settlement. The paired control is a composer-owned
// prompt, written to the chat's draft once.
it('keeps a caller-kept prompt with its caller on the direct path', async () => {
  const kept = stagedWithoutSlot('direct-caller-kept', { callerKeepsText: true })
  const result = await launch('direct-caller-kept', kept)

  expect(attempts.count).toBe(1)
  expect(draft.writes).toEqual([])
  expect(result.inComposer).toBeUndefined()
  expect((await newAgentPromptOutcome({ delivery: Promise.resolve(result) })).delivered).toBe(false)

  const owned = stagedWithoutSlot('direct-composer-owned')
  expect((await launch('direct-composer-owned', owned)).inComposer).toBe(true)
  expect(draft.writes).toEqual(['direct-composer-owned'])
})

// A preparation that fails after create says why, and a hand-back that then throws adds that the
// message wasn't saved rather than being worded over (a thrown draft write, not the deferred observer
// fault of C13-e1).
it('says why preparation failed and that a lost hand-back was not saved', async () => {
  const quiet = vi.spyOn(console, 'error').mockImplementation(() => {})
  const sessionId = 'prepare-failed-lost'
  const prompt = stageStructuredLaunchPrompt(sessionId, 'launch text', {
    prepare: async () => {
      throw new Error('The chat attachment host is unavailable.')
    }
  })
  draft.mode = 'lost'

  const result = await launch(sessionId, prompt)

  expect(result.inComposer).toBeUndefined()
  expect(result.handBackFinished).toBeUndefined()
  const notice = getStructuredAgentSessionSendNotice(sessionId) ?? ''
  expect(notice).toContain('The chat attachment host is unavailable.')
  expect(notice).toContain("Couldn't save your message.")
  quiet.mockRestore()
})
