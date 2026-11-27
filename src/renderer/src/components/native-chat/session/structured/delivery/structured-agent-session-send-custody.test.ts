import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  mocks,
  SESSION,
  flush,
  okSubmission,
  sendCalls
} from '@/components/native-chat/session/structured/delivery/structured-agent-session-message-sender.test-fixture'
import {
  dropStructuredAgentSessionSends,
  reserveStructuredAgentSessionSend,
  resetStructuredAgentSessionSendsForTests,
  sendStructuredAgentSessionMessage
} from '@/components/native-chat/session/structured/delivery/structured-agent-session-message-sender'
import { structuredAgentSessionSendCustodyLost } from '@/components/native-chat/session/structured/delivery/structured-agent-session-send-runtime'
import { getStructuredAgentSessionSendNotice } from '@/components/native-chat/session/structured/delivery/structured-agent-session-pending-sends'
import { noteStructuredAgentSessionFence } from '@/components/native-chat/session/structured/delivery/structured-agent-session-send-attempt'
import { stagedDeliveryFromSlotOutcome } from '@/lib/agent-session/launch/structured-agent-session-staged-prompt'
import type { StagedStructuredLaunchPrompt } from '@/lib/agent-session/launch/structured-agent-session-staged-prompt'

// The host request, the environment compatibility check and the draft write are the stand-ins
// (see the fixture); reservation, preparation reaction, gate, attempt and settlement run for real.
const environment = { kind: 'environment', environmentId: 'env-1' } as const
const HOST_A = '/host/agent-session-attachments/upload-a/a.png'
const HOST_B = '/host/agent-session-attachments/upload-b/b.png'

beforeEach(() => {
  mocks.call.mockReset()
  mocks.handBack.mockReset()
  mocks.handBack.mockReturnValue(true)
  mocks.compatible.mockReset()
  mocks.compatible.mockResolvedValue(undefined)
  noteStructuredAgentSessionFence(SESSION, 4)
})
afterEach(() => {
  resetStructuredAgentSessionSendsForTests()
})

/** A compatibility check that waits until released: the window between prepare and the request. */
function heldCompatibility(): () => void {
  let release = (): void => {}
  mocks.compatible.mockImplementation(() => new Promise<void>((resolve) => (release = resolve)))
  return () => release()
}

/** A prepared send whose preparation mapped both originals to host uploads, with its custody grant. */
function preparedSend(lost: { now: string[] }) {
  return sendStructuredAgentSessionMessage({
    sessionId: SESSION,
    target: environment,
    text: 'compare [Image #1] with [Image #2]',
    attachments: [
      { path: 'orca-browser-file:a/a.png', previewUri: '' },
      { path: 'orca-browser-file:b/b.png', previewUri: '' }
    ],
    prepareAttachments: async (input) => ({
      ...input,
      attachments: [
        { path: HOST_A, previewUri: '' },
        { path: HOST_B, previewUri: '' }
      ],
      custodyLost: () => lost.now
    })
  })!
}

// D11-03 / C15-03, at the issue. An adoption during the attempt's own awaits (here the environment
// check) revokes the grant: the request is never made, the message comes back whole, and the send
// settles once, as returned.
it('issues nothing for a prepared send that lost custody before its request', async () => {
  const release = heldCompatibility()
  const lost: { now: string[] } = { now: [] }
  const sent = preparedSend(lost)
  await flush()
  expect(mocks.compatible).toHaveBeenCalledTimes(1)

  lost.now = ['orca-browser-file:a/a.png']
  release()

  expect(await sent.outcome).toBe('returned')
  expect(sendCalls()).toBe(0)
  expect(mocks.handBack).toHaveBeenCalledTimes(1)
  expect(getStructuredAgentSessionSendNotice(SESSION)).toContain("Can't send a.png from this chat.")
})

// The control: with its grant intact, the same send goes out once with exactly the prepared paths in
// their attachment order and its numbering unchanged.
it('issues a prepared send whose grant holds, with its exact ordered paths', async () => {
  mocks.call.mockImplementation(
    async (_target, _method, params: { envelope: { clientOperationId: string } }) =>
      okSubmission(params.envelope.clientOperationId, 'accepted')
  )
  const sent = preparedSend({ now: [] })

  expect(await sent.outcome).toBe('recorded')
  expect(sendCalls()).toBe(1)
  const params = mocks.call.mock.calls.find((call) => call[1] === 'agentSession.send')![2]
  expect(
    params.body.blocks.flatMap((block: { type: string; path?: string }) =>
      block.type === 'image-ref' ? [block.path] : []
    )
  ).toEqual([HOST_A, HOST_B])
  expect(params.body.blocks[0]).toEqual({
    type: 'text',
    text: 'compare [Image #1] with [Image #2]'
  })
  expect(mocks.handBack).not.toHaveBeenCalled()
})

// D11-04. A returned outcome only says the send ended. What the hand-back left decides whether a
// launch may claim the recipient's draft holds the message: durable, installed (draft write not yet
// saved), lost (the hand-back threw) or caller (the caller kept the text). Each settles exactly once.
it.each([
  ['durable', () => true, true],
  ['installed', () => false, false],
  [
    'lost',
    () => {
      throw new Error('observer threw')
    },
    false
  ]
] as const)(
  'reports a %s hand-back, and claims the draft holds it only when durable',
  async (custody, handBack, inComposer) => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {})
    mocks.handBack.mockImplementation(handBack)
    const slot = reserveStructuredAgentSessionSend({ sessionId: SESSION, text: 'first message' })!
    slot.fail('The chat attachment host is unavailable.')

    const outcome = await slot.outcome
    expect(outcome).toBe('returned')
    expect(slot.handedBack()).toBe(custody)
    expect(mocks.handBack).toHaveBeenCalledTimes(1)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the mapping reads only these two fields.
    const prompt = { slot, callerKeepsText: undefined } as unknown as StagedStructuredLaunchPrompt
    expect(stagedDeliveryFromSlotOutcome(prompt, outcome).inComposer).toBe(inComposer)
    const notice = getStructuredAgentSessionSendNotice(SESSION) ?? ''
    // Only a hand-back that threw says the message wasn't saved; an unsaved draft shows its own mark.
    expect(notice.includes("Couldn't save your message.")).toBe(custody === 'lost')
    quiet.mockRestore()
  }
)

it('reports a caller-kept hand-back without claiming the draft holds it', async () => {
  const slot = reserveStructuredAgentSessionSend({
    sessionId: SESSION,
    text: 'an answer',
    callerKeepsText: true
  })!
  slot.fail('not sent')

  const outcome = await slot.outcome
  expect(outcome).toBe('returned')
  expect(slot.handedBack()).toBe('caller')
  expect(mocks.handBack).not.toHaveBeenCalled()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the mapping reads only these two fields.
  const prompt = { slot, callerKeepsText: true } as unknown as StagedStructuredLaunchPrompt
  expect(stagedDeliveryFromSlotOutcome(prompt, outcome).inComposer).toBe(false)
})

/** A grant that reports a lost original only once `probe.on` flips, so the attempt is not refused. */
function probeGrant() {
  const probe = { on: false }
  return { probe, custodyLost: () => (probe.on ? ['orca-browser-file:probe/p.png'] : []) }
}

// C16-05. A dropped direct send keeps no custody grant: dropped before its issue, it never reaches the
// host and its grant is gone; dropped after its issue, the late reply changes nothing and its grant is
// gone too. The reserved control drops its grant the same way.
it('retains no custody grant for a dropped send, before or after its issue', async () => {
  const release = heldCompatibility()
  const early = probeGrant()
  const before = sendStructuredAgentSessionMessage({
    sessionId: SESSION,
    target: environment,
    text: 'dropped before issue',
    custodyLost: early.custodyLost
  })!
  await flush()
  dropStructuredAgentSessionSends(SESSION)
  early.probe.on = true
  expect(structuredAgentSessionSendCustodyLost(before.clientMessageId)).toEqual([])
  release()
  expect(await before.outcome).toBe('dropped')
  await flush()
  expect(sendCalls()).toBe(0)

  // The drop forgot the chat's fence with its sends; the next send needs one again.
  noteStructuredAgentSessionFence(SESSION, 4)
  mocks.compatible.mockResolvedValue(undefined)
  let reply = (_value: unknown): void => {}
  mocks.call.mockImplementation(() => new Promise((resolve) => (reply = resolve)))
  const late = probeGrant()
  const after = sendStructuredAgentSessionMessage({
    sessionId: SESSION,
    target: environment,
    text: 'dropped after issue',
    custodyLost: late.custodyLost
  })!
  await vi.waitFor(() => expect(sendCalls()).toBe(1))
  dropStructuredAgentSessionSends(SESSION)
  late.probe.on = true
  expect(structuredAgentSessionSendCustodyLost(after.clientMessageId)).toEqual([])
  reply(okSubmission(after.clientMessageId, 'accepted'))
  expect(await after.outcome).toBe('dropped')
  await flush()
  expect(structuredAgentSessionSendCustodyLost(after.clientMessageId)).toEqual([])

  const reserved = reserveStructuredAgentSessionSend({ sessionId: SESSION, text: 'reserved' })!
  const held = probeGrant()
  reserved.prepare({ text: 'reserved' }, held.custodyLost)
  dropStructuredAgentSessionSends(SESSION)
  held.probe.on = true
  expect(structuredAgentSessionSendCustodyLost(reserved.clientMessageId)).toEqual([])
  expect(await reserved.outcome).toBe('dropped')
})
