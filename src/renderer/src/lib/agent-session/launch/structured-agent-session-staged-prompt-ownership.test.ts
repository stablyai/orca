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

const { finishStagedLaunchPromptWithHandBack, stageStructuredLaunchPrompt } =
  await import('./structured-agent-session-staged-prompt')
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
