import { expect, it, vi } from 'vitest'
import type * as HandBack from '@/components/native-chat/session/structured/delivery/structured-agent-session-message-hand-back'

// The draft write is the only stand-in, counted: reservations, Stop, settlement and the terminal
// hand-back run for real.
const handBacks: string[] = []
vi.mock(
  '@/components/native-chat/session/structured/delivery/structured-agent-session-message-hand-back',
  async (importOriginal) => ({
    ...(await importOriginal<typeof HandBack>()),
    handBackStructuredAgentSessionMessage: (sessionId: string) => {
      handBacks.push(sessionId)
      return true
    }
  })
)

const {
  finishStagedLaunchPromptWithHandBack,
  stageStructuredLaunchPrompt,
  takeBackLegacyStructuredLaunchPrompts
} = await import('./structured-agent-session-staged-prompt')
const { settleStructuredAgentLaunchPrompt } =
  await import('./structured-agent-session-launch-prompt')
const { getStructuredAgentSessionPendingSends } =
  await import('@/components/native-chat/session/structured/delivery/structured-agent-session-pending-sends')
const { reserveStructuredAgentSessionSend, stopStructuredAgentSessionSends } =
  await import('@/components/native-chat/session/structured/delivery/structured-agent-session-message-sender')

const count = (sessionId: string): number => handBacks.filter((id) => id === sessionId).length

// A launch prompt with no reservation of its own (another send held the chat) is handed back by the
// terminal path, once: a later terminal path finds it settled and reports that same result.
it('hands back a prompt with no reservation once, then keeps its settled result', async () => {
  const sessionId = 'ownership-unreserved'
  const other = reserveStructuredAgentSessionSend({ sessionId, text: 'other send' })!
  const prompt = stageStructuredLaunchPrompt(sessionId, 'launch text')
  expect(prompt.slot).toBeNull()

  const first = await finishStagedLaunchPromptWithHandBack(prompt, { busy: true })
  expect(first).toMatchObject({ delivered: false, inComposer: true, handBackFinished: true })
  expect(count(sessionId)).toBe(1)

  const again = await finishStagedLaunchPromptWithHandBack(prompt, { failureNotified: true })
  expect(again).toBe(first)
  expect(count(sessionId)).toBe(1)
  other.release()
})

// Stop returned the reserved launch message itself; the terminal path that runs next contributes that
// reservation's actual outcome (back in the composer) and writes the message no second time.
it('reports a stopped reservation outcome without a second hand-back', async () => {
  const sessionId = 'ownership-stopped'
  const prompt = stageStructuredLaunchPrompt(sessionId, 'launch text')
  expect(prompt.slot?.active()).toBe(true)

  stopStructuredAgentSessionSends(sessionId)
  expect(count(sessionId)).toBe(1)
  const result = await finishStagedLaunchPromptWithHandBack(prompt, { busy: true })

  expect(result).toMatchObject({ delivered: false, inComposer: true })
  expect(result.handBackFinished).toBeUndefined()
  expect(result.busy).toBeUndefined()
  expect(count(sessionId)).toBe(1)
  expect(await prompt.whenCreateSettled).toMatchObject({ inComposer: true })
})

const target = { kind: 'environment' as const, environmentId: 'env' }

// Preparation can leave nothing this chat owns (everything went to the chat a refusal returned it to,
// after the plan was made): nothing is sent and nothing is handed back here, and the result says the
// launch input is finished with, so the first send's files are not kept waiting for this chat.
it('sends and hands back nothing when preparation leaves nothing this chat owns', async () => {
  const sessionId = 'ownership-prepared-empty'
  const prompt = stageStructuredLaunchPrompt(sessionId, 'see the image', {
    prepare: async () => ({ text: '', attachments: [] })
  })

  const result = await settleStructuredAgentLaunchPrompt({
    launchResult: Promise.resolve({ sessionId, fence: 1 }),
    target,
    options: { prompt: 'see the image' },
    stagedPrompt: prompt
  })

  expect(result).toMatchObject({ delivered: false, handBackFinished: true })
  expect(result?.inComposer).toBeUndefined()
  expect(count(sessionId)).toBe(0)
  expect(getStructuredAgentSessionPendingSends(sessionId)).toEqual([])
})

// A legacy take-back that meets a reservation which already ended on its own (here a Stop returned the
// message) announces the discard only after that actual result: the launch reports the message back in
// the composer, not a generic discard, and it is written once.
it('reports the actual return before a legacy take-back announces the discard', async () => {
  const sessionId = 'ownership-legacy-take-back'
  const prompt = stageStructuredLaunchPrompt(sessionId, 'launch text')
  const settled = settleStructuredAgentLaunchPrompt({
    launchResult: new Promise(() => {}),
    target,
    options: { prompt: 'launch text' },
    stagedPrompt: prompt
  })

  stopStructuredAgentSessionSends(sessionId)
  takeBackLegacyStructuredLaunchPrompts(sessionId)

  expect(await settled).toMatchObject({ delivered: false, inComposer: true })
  expect(count(sessionId)).toBe(1)
})
