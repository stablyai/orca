import { expect, it, vi } from 'vitest'
import type { StructuredAgentSessionPendingSend } from '@/components/native-chat/session/structured/delivery/structured-agent-session-pending-sends'

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
  const outcome = async (delivered: boolean, transferred: boolean): Promise<string> => {
    let result = 'kept'
    const delivery = Promise.resolve({ delivered, failureNotified: !delivered })
    releaseFirstSendFilesWhenHeld(delivery, () => transferred, {
      release: () => (result = 'released'),
      releaseWhenHeld: () => (result = 'when-held')
    })
    await delivery
    await Promise.resolve()
    return result
  }
  expect(await outcome(true, false)).toBe('released')
  expect(await outcome(true, true)).toBe('released')
  expect(await outcome(false, true)).toBe('when-held')
  expect(await outcome(false, false)).toBe('kept')
})

const { reserveStructuredAgentSessionSend, dropStructuredAgentSessionSends } =
  await import('@/components/native-chat/session/structured/delivery/structured-agent-session-message-sender')
const { retainUnconfirmed, settleRecorded, structuredAgentSessionSendRecorded } =
  await import('@/components/native-chat/session/structured/delivery/structured-agent-session-send-runtime')
const { findStructuredAgentSessionPendingSend } =
  await import('@/components/native-chat/session/structured/delivery/structured-agent-session-pending-sends')
const { unconfirmedStructuredLaunchDelivery, discardStructuredAgentSessionChatSends } =
  await import('@/lib/agent-session/launch/structured-agent-session-staged-prompt')
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
    () => true,
    { release: () => calls.push('release'), releaseWhenHeld: () => calls.push('when-held') }
  )
  for (let tick = 0; tick < 4; tick += 1) {
    await Promise.resolve()
  }

  expect(calls).toEqual(['when-held', 'release'])
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
  for (const settled of [{ recipientOwned: true as const }, { inComposer: true as const }]) {
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
    releaseFirstSendFilesWhenHeld(delivery, () => true, files)
    await delivery
    await Promise.resolve()

    expect(hasNativeChatStagedFiles(scope)).toBe(false)
  }
})
