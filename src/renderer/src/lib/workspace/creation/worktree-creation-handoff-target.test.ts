import { expect, it, vi } from 'vitest'
import type { StructuredAgentSessionPendingSend } from '@/components/native-chat/session/structured/delivery/structured-agent-session-pending-sends'
import type * as HandBack from '@/components/native-chat/session/structured/delivery/structured-agent-session-message-hand-back'

const tabs = new Map<string, Record<string, unknown>>()
vi.mock('@/store/index', () => ({
  useAppStore: { getState: () => ({ getTab: (id: string) => tabs.get(id) ?? null }) }
}))
vi.mock('@/lib/agent-session/launch/structured-agent-session-launch-registry', () => ({
  getStructuredAgentSessionLaunchOwner: () => undefined
}))
// The host transport is the stand-in: a dispatched send gets its real recorded signal and no reply.
vi.mock(
  '@/components/native-chat/session/structured/delivery/structured-agent-session-send-dispatch',
  async () => {
    const runtime =
      await import('@/components/native-chat/session/structured/delivery/structured-agent-session-send-runtime')
    return {
      dispatchStructuredAgentSessionSend: (entry: StructuredAgentSessionPendingSend) => ({
        clientMessageId: entry.clientMessageId,
        outcome: new Promise(() => {}),
        recorded: runtime.structuredAgentSessionSendRecorded(entry.clientMessageId)
      })
    }
  }
)
// The draft journal's synchronous answer is the other stand-in: a full or refused journal (quota)
// makes the returned launch message non-durable although its hand-back has happened.
vi.mock(
  '@/components/native-chat/session/structured/delivery/structured-agent-session-message-hand-back',
  async (importOriginal) => ({
    ...(await importOriginal<typeof HandBack>()),
    handBackStructuredAgentSessionMessage: () => false
  })
)

const {
  confirmWorktreeCreationHandoffTarget,
  readWorktreeCreationHandoffTarget,
  releaseFirstSendFilesWhenHeld
} = await import('./worktree-creation-handoff-target')

const chat = { id: 'tab', contentType: 'agent-session', worktreeId: 'wt' }

// The draft moves only into the chat captured before the readiness wait, if it is still that session
// on that host; a closed tab, a replaced session or a changed host keeps the input at its source.
it('confirms a handoff target only while its tab, session and host are unchanged', () => {
  tabs.set('tab', { ...chat, entityId: 'session-1', executionHostId: 'local' })
  const captured = readWorktreeCreationHandoffTarget('tab', 'wt')
  expect(captured).not.toBeNull()
  expect(confirmWorktreeCreationHandoffTarget(captured!, 'wt')?.sessionId).toBe('session-1')

  tabs.set('tab', { ...chat, entityId: 'session-2', executionHostId: 'local' })
  expect(confirmWorktreeCreationHandoffTarget(captured!, 'wt')).toBeNull()
  tabs.set('tab', { ...chat, entityId: 'session-1', executionHostId: 'remote-host' })
  expect(confirmWorktreeCreationHandoffTarget(captured!, 'wt')).toBeNull()
  tabs.delete('tab')
  expect(confirmWorktreeCreationHandoffTarget(captured!, 'wt')).toBeNull()
})

// The first send's files are released outright only on a recorded delivery. After a confirmed move
// they wait for the recipient's draft to hold them; an undelivered send to a stale chat keeps them for Retry.
it('releases the first send files on delivery, waits for custody after a move, else keeps them', async () => {
  const outcome = async (delivered: boolean, _transferred: boolean): Promise<string> => {
    let result = 'kept'
    const delivery = Promise.resolve({ delivered, failureNotified: !delivered })
    releaseFirstSendFilesWhenHeld(delivery, 'retry-source', {
      release: () => (result = 'released'),
      retainForRetry: () => (result = 'retained')
    })
    await delivery
    await Promise.resolve()
    return result
  }
  expect(await outcome(true, false)).toBe('released')
  expect(await outcome(true, true)).toBe('released')
  expect(await outcome(false, true)).toBe('released')
  expect(await outcome(false, false)).toBe('released')
})

const { reserveStructuredAgentSessionSend, dropStructuredAgentSessionSends } =
  await import('@/components/native-chat/session/structured/delivery/structured-agent-session-message-sender')
const { retainUnconfirmed, settleRecorded, structuredAgentSessionSendRecorded } =
  await import('@/components/native-chat/session/structured/delivery/structured-agent-session-send-runtime')
const { findStructuredAgentSessionPendingSend } =
  await import('@/components/native-chat/session/structured/delivery/structured-agent-session-pending-sends')
const {
  discardStructuredAgentSessionChatSends,
  prepareStructuredLaunchPromptForCreate,
  stageStructuredLaunchPrompt,
  unconfirmedStructuredLaunchDelivery
} = await import('@/lib/agent-session/launch/structured-agent-session-staged-prompt')
const { settleStructuredAgentLaunchPrompt } =
  await import('@/lib/agent-session/launch/structured-agent-session-launch-prompt')
const { StructuredAgentSessionCreateRefusalError } =
  await import('@/lib/agent-session/launch/structured-agent-session-launch-errors')
const { captureNativeChatStagedInput } =
  await import('@/components/native-chat/drafts/native-chat-staged-input')
const { hasNativeChatStagedFiles, reconcileNativeChatStagedDraft, stageNativeChatDraftFile } =
  await import('@/components/native-chat/drafts/native-chat-draft-attachment-staging')
const { structuredAgentSessionDraftScopeKey } =
  await import('@/components/native-chat/drafts/native-chat-draft-scope')

const pendingOf = (
  sessionId: string,
  clientMessageId: string
): StructuredAgentSessionPendingSend => {
  const entry = findStructuredAgentSessionPendingSend(sessionId, clientMessageId)
  expect(entry).toBeDefined()
  return entry!
}

// The paired launch's reserved send reports `unconfirmed`, and the journal records that exact send
// before anyone subscribes: the recorded signal belongs to the send itself, so the first-send files are
// still released once the lease owner listens.
it('releases the first send files when a reserved send is recorded after unconfirmed', async () => {
  const slot = reserveStructuredAgentSessionSend({ sessionId: 'late-reserved', text: 'hi' })!
  const entry = pendingOf('late-reserved', slot.clientMessageId)
  retainUnconfirmed(entry)
  settleRecorded(entry, null, 'journal')

  const calls: string[] = []
  releaseFirstSendFilesWhenHeld(
    Promise.resolve({
      delivered: false,
      failureNotified: false,
      ...unconfirmedStructuredLaunchDelivery('unconfirmed', slot.recorded)
    }),
    'retry-source',
    { release: () => calls.push('release'), retainForRetry: () => calls.push('retained') }
  )
  for (let tick = 0; tick < 4; tick += 1) {
    await Promise.resolve()
  }

  expect(calls).toEqual(['retained', 'release'])
  slot.release()
})

// Dropping a chat's sends ends their recorded signals, even for a send already out of its reservation
// whose live runtime is gone after an `unconfirmed` outcome.
it('ends a dropped unconfirmed send recorded signal', () => {
  const slot = reserveStructuredAgentSessionSend({ sessionId: 'late-dropped', text: 'hi' })!
  slot.send({ kind: 'local' })
  retainUnconfirmed(pendingOf('late-dropped', slot.clientMessageId))

  dropStructuredAgentSessionSends('late-dropped')

  expect(structuredAgentSessionSendRecorded(slot.clientMessageId)).not.toBe(slot.recorded)
})

// After a confirmed move, a recipient discarded before the lease owner heard the result (or a send
// already handed back to the composer) leaves no custody to wait for: the first-send files go now.
it('releases moved first-send files when the recipient was discarded before the result', async () => {
  for (const settled of [
    { handBackFinished: true as const },
    { inComposer: true as const, handBackFinished: true as const }
  ]) {
    const sessionId = `discard-first-${Object.keys(settled)[0]}`
    const scope = structuredAgentSessionDraftScopeKey(sessionId)
    stageNativeChatDraftFile(scope, `blob:${sessionId}`)
    const files = captureNativeChatStagedInput(scope, {
      text: '',
      attachments: [{ path: `blob:${sessionId}` }]
    })
    reconcileNativeChatStagedDraft(scope, { text: '', images: [] })
    discardStructuredAgentSessionChatSends(sessionId)
    expect(hasNativeChatStagedFiles(scope)).toBe(true)

    const delivery = Promise.resolve({ delivered: false, failureNotified: true, ...settled })
    releaseFirstSendFilesWhenHeld(delivery, 'retry-source', files)
    await delivery
    await Promise.resolve()

    expect(hasNativeChatStagedFiles(scope)).toBe(false)
  }
})

// A deferred launch whose create is refused hands its message back before any send. When the draft
// journal refuses that write, the result is not `inComposer`, yet the operation is over: it reports
// `handBackFinished`, and a moved first send's lease ends instead of waiting on a send that never comes.
it('ends a moved first-send lease after a create refusal whose hand-back was not durable', async () => {
  const sessionId = 'create-refused-quota'
  const scope = structuredAgentSessionDraftScopeKey(sessionId)
  stageNativeChatDraftFile(scope, 'blob:create-refused')
  const files = captureNativeChatStagedInput(scope, {
    text: '',
    attachments: [{ path: 'blob:create-refused' }]
  })
  reconcileNativeChatStagedDraft(scope, { text: '', images: [] })
  const stagedPrompt = stageStructuredLaunchPrompt(sessionId, 'hi')

  const delivery = settleStructuredAgentLaunchPrompt({
    launchResult: Promise.reject(new StructuredAgentSessionCreateRefusalError('refused')),
    target: { kind: 'local' },
    options: { prompt: 'hi' },
    stagedPrompt
  })!
  const result = await delivery
  expect(result.inComposer).toBeUndefined()
  expect(result.handBackFinished).toBe(true)

  releaseFirstSendFilesWhenHeld(delivery, 'retry-source', files)
  await Promise.resolve()
  await Promise.resolve()

  expect(hasNativeChatStagedFiles(scope)).toBe(false)
})

// Paired create succeeded, then attachment preparation rejects while the reservation is still held:
// the terminal hand-back is published before the reservation is released, so the public result (not
// the reservation's generic "dropped") carries `handBackFinished` and the moved lease ends.
it('reports a finished hand-back when preparation fails after a successful create', async () => {
  const sessionId = 'prepare-rejected-after-create'
  const scope = structuredAgentSessionDraftScopeKey(sessionId)
  stageNativeChatDraftFile(scope, 'blob:prepare-rejected')
  const files = captureNativeChatStagedInput(scope, {
    text: '',
    attachments: [{ path: 'blob:prepare-rejected' }]
  })
  reconcileNativeChatStagedDraft(scope, { text: '', images: [] })
  const stagedPrompt = stageStructuredLaunchPrompt(sessionId, 'hi', {
    prepare: async () => {
      throw new Error('preparation failed')
    }
  })
  expect(stagedPrompt.slot).not.toBeNull()

  const delivery = settleStructuredAgentLaunchPrompt({
    launchResult: Promise.resolve({ sessionId, fence: 1 }),
    target: { kind: 'environment', environmentId: 'env' },
    options: { prompt: 'hi' },
    stagedPrompt
  })!
  const result = await delivery
  expect(result.handBackFinished).toBe(true)

  releaseFirstSendFilesWhenHeld(delivery, 'retry-source', files)
  await Promise.resolve()
  await Promise.resolve()
  expect(hasNativeChatStagedFiles(scope)).toBe(false)
})

// A create-owned prompt that never had a reservation (another send held the slot) was taken by
// nothing: it is handed back for real and reports that, never an assumed "in the composer".
it('hands back a create-owned prompt with no reservation instead of assuming the composer has it', async () => {
  const sessionId = 'create-owned-without-slot'
  const holder = reserveStructuredAgentSessionSend({ sessionId, text: 'already sending' })!
  const stagedPrompt = stageStructuredLaunchPrompt(sessionId, 'hi')
  expect(stagedPrompt.slot).toBeNull()

  prepareStructuredLaunchPromptForCreate(sessionId, { kind: 'local' })
  const settled = await stagedPrompt.whenCreateSettled

  expect(settled.handBackFinished).toBe(true)
  expect(settled.inComposer).toBe(false)
  holder.release()
})
