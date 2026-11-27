import { expect, it, vi } from 'vitest'
import type * as HandBack from '@/components/native-chat/session/structured/delivery/structured-agent-session-message-hand-back'
import type * as SendAttempt from '@/components/native-chat/session/structured/delivery/structured-agent-session-send-attempt'

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

// The host request records what would have left the renderer.
const attempted: unknown[] = []
vi.mock(
  '@/components/native-chat/session/structured/delivery/structured-agent-session-send-attempt',
  async (importOriginal) => ({
    ...(await importOriginal<typeof SendAttempt>()),
    attemptStructuredAgentSessionSend: (args: { entry: { body: unknown } }) => {
      attempted.push(args.entry.body)
      return new Promise(() => {})
    }
  })
)

const {
  finishStagedLaunchPromptWithHandBack,
  prepareStructuredLaunchPromptForCreate,
  stageStructuredLaunchPrompt,
  takeBackLegacyStructuredLaunchPrompts
} = await import('./structured-agent-session-staged-prompt')
const { holdBrowserAttachmentFiles } = await import('@/lib/files/drop/browser-attachment-files')
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
  // The reservation's own hand-back ended the operation, and its result says so (D12-01 / C16-02).
  expect(result.handBackFinished).toBe(true)
  expect(result.busy).toBeUndefined()
  expect(count(sessionId)).toBe(1)
  expect(await prompt.whenCreateSettled).toMatchObject({ inComposer: true })
})

const target = { kind: 'environment' as const, environmentId: 'env' }

// A create never carries a first message that still names a browser file (nothing prepared it into a
// host upload): the create goes without it, and the launch's own send afterwards reaches the one place
// a message leaves, which refuses it whole before any request and returns it to the chat's composer.
it('lets no create carry a prompt naming a browser file; it is refused before any request', async () => {
  const sessionId = 'ownership-browser-file'
  const [token] = holdBrowserAttachmentFiles([new File(['x'], 'shot.png')])
  const attachments = [{ path: token, previewUri: '' }]
  const prompt = stageStructuredLaunchPrompt(sessionId, 'look at [Image #1]', { attachments })

  expect(prepareStructuredLaunchPromptForCreate(sessionId, target)).toEqual({ deferred: true })
  expect(prompt.createOwned).toBeUndefined()

  const result = await settleStructuredAgentLaunchPrompt({
    launchResult: Promise.resolve({ sessionId, fence: 1 }),
    target,
    options: { prompt: 'look at [Image #1]', promptAttachments: attachments },
    stagedPrompt: prompt
  })

  expect(result).toMatchObject({ delivered: false, inComposer: true })
  expect(attempted).toEqual([])
  expect(count(sessionId)).toBe(1)
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
