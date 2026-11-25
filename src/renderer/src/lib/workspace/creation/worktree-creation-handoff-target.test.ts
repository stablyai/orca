import { expect, it, vi } from 'vitest'
import type { StructuredAgentSessionPendingSend } from '@/components/native-chat/session/structured/delivery/structured-agent-session-pending-sends'

const tabs = new Map<string, Record<string, unknown>>()
vi.mock('@/store/index', () => ({
  useAppStore: { getState: () => ({ getTab: (id: string) => tabs.get(id) ?? null }) }
}))
vi.mock('@/lib/agent-session/launch/structured-agent-session-launch-registry', () => ({
  getStructuredAgentSessionLaunchOwner: () => undefined
}))

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

// A first send first reported unconfirmed and later recorded by the journal is a recorded delivery:
// its files are released then, even though the original delivery promise already settled.
it('releases the first send files when an unconfirmed send is later recorded', async () => {
  const { retainUnconfirmed, settleRecorded, whenStructuredAgentSessionSendRecorded } =
    await import('@/components/native-chat/session/structured/delivery/structured-agent-session-send-runtime')
  const entry: StructuredAgentSessionPendingSend = {
    clientMessageId: 'late-recorded-send',
    sessionId: 'late-recorded-session',
    body: { kind: 'message', role: 'user', blocks: [] },
    previewUris: [],
    queuedAt: 0,
    phase: 'sending',
    issued: true
  }
  const calls: string[] = []
  const delivery = Promise.resolve({
    delivered: false,
    failureNotified: false,
    unconfirmed: true as const,
    whenRecorded: whenStructuredAgentSessionSendRecorded(entry.clientMessageId)
  })
  releaseFirstSendFilesWhenHeld(delivery, () => true, {
    release: () => calls.push('release'),
    releaseWhenHeld: () => calls.push('when-held')
  })
  retainUnconfirmed(entry)
  await delivery
  await Promise.resolve()
  expect(calls).toEqual(['when-held'])

  settleRecorded(entry, null, 'journal')
  await Promise.resolve()
  await Promise.resolve()

  expect(calls).toEqual(['when-held', 'release'])
})
