// A sent message is kept beside the chat's live draft until the host holds it. After a crash, the
// relaunched chat's journal decides each held send: dropped when the host holds it, otherwise put
// back into the box after anything typed. The live draft is never hidden or held back meanwhile.

// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentJournalSubmission } from '../../../../shared/agent-session-journal-types'
import type { AgentSessionQueuedMessage } from '../../../../shared/agent-session-queued-message-wire'
import type { NativeChatDraftsApi } from '../../../../preload/api-types'
import type { PersistedNativeChatDraft } from '../../../../shared/native-chat-draft-record'
import { installLocalStorageNativeChatDrafts } from './native-chat-draft-store.test-support'

const CHAT = 'session:s1'
const PREFIX = 'orca:nativeChatComposerDraft:v1:'

function saved(): PersistedNativeChatDraft | null {
  const raw = localStorage.getItem(`${PREFIX}${encodeURIComponent(CHAT)}`)
  return raw ? JSON.parse(raw) : null
}

function submission(
  clientMessageId: string,
  dispatchState: AgentJournalSubmission['dispatchState'],
  overrides: Partial<AgentJournalSubmission> = {}
): AgentJournalSubmission {
  return {
    clientMessageId,
    fence: 1,
    payloadFingerprint: 'fingerprint',
    dispatchState,
    providerItemId: null,
    reason: null,
    submittedAt: 1,
    resolvedAt: null,
    handoverRecorded: true,
    ...overrides
  }
}

function card(messageId: string): AgentSessionQueuedMessage {
  return {
    messageId,
    position: 1,
    body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'sent once' }] },
    state: 'waiting'
  }
}

type Journal = {
  status: 'idle' | 'loading' | 'ready' | 'error'
  submissions: readonly AgentJournalSubmission[]
  queuedMessages?: readonly AgentSessionQueuedMessage[]
}

let store: NativeChatDraftsApi

/** A fresh renderer: module memory is gone, only the saved drafts remain. */
async function relaunch() {
  vi.resetModules()
  const cache = await import('./native-chat-draft-cache')
  const heldSends = await import('./native-chat-held-sends')
  const { useNativeChatHeldSends } = await import('./use-native-chat-held-sends')
  const view = renderHook((journal: Journal) => useNativeChatHeldSends(CHAT, journal), {
    initialProps: { status: 'loading', submissions: [] }
  })
  return { cache, heldSends, view }
}

beforeEach(async () => {
  localStorage.clear()
  store = installLocalStorageNativeChatDrafts({ like: 'desktop' })
  // The earlier run: the box was being edited when a send of 'sent once' was still held.
  await store.write(CHAT, {
    text: 'typed before',
    attachments: [],
    importedOutboxEntryIds: ['old-outbox-entry'],
    heldSends: [{ clientMessageId: 'm1', text: 'sent once', attachments: [], sentAt: 5 }]
  })
})

afterEach(() => {
  cleanup()
})

describe('a relaunch with a held send left by a crash', () => {
  it.each([
    ['the agent accepted it', { submissions: [submission('m1', 'accepted')] }],
    ['the host keeps it as a card', { submissions: [], queuedMessages: [card('m1')] }],
    [
      'a submission handed that card off',
      { submissions: [submission('h1', 'pending', { queuedMessageId: 'm1' })] }
    ]
  ] as const)('drops it when %s', async (_label, journal) => {
    const { cache, view } = await relaunch()

    view.rerender({ status: 'ready', ...journal })
    await act(async () => {})

    expect(cache.readNativeChatDraftCache(CHAT)).toBe('typed before')
    expect(saved()?.heldSends).toBeUndefined()
    expect(saved()?.importedOutboxEntryIds).toEqual(['old-outbox-entry'])
  })

  it.each([
    ['has no submission for it', []],
    ['has it pending, not yet accepted by the agent', [submission('m1', 'pending')]]
  ] as const)('puts it back after the box when the journal %s', async (_label, submissions) => {
    const { cache, view } = await relaunch()

    view.rerender({ status: 'ready', submissions })
    await act(async () => {})

    expect(cache.readNativeChatDraftCache(CHAT)).toBe('typed before\n\nsent once')
    expect(saved()).toMatchObject({
      text: 'typed before\n\nsent once',
      importedOutboxEntryIds: ['old-outbox-entry']
    })
    expect(saved()?.heldSends).toBeUndefined()
  })

  it('puts it back when the journal cannot be read, even one that holds it', async () => {
    const { cache, view } = await relaunch()

    view.rerender({ status: 'error', submissions: [submission('m1', 'accepted')] })
    await act(async () => {})

    expect(cache.readNativeChatDraftCache(CHAT)).toBe('typed before\n\nsent once')
  })

  it('shows and saves the box at once, and keeps a send made while the journal is read', async () => {
    const { cache, heldSends, view } = await relaunch()
    expect(cache.readNativeChatDraftCache(CHAT)).toBe('typed before')

    cache.writeNativeChatDraftCache(CHAT, 'second message', 'now')
    await act(async () => {})
    expect(saved()).toMatchObject({
      text: 'second message',
      heldSends: [{ clientMessageId: 'm1' }]
    })

    act(() => heldSends.holdNativeChatDraftSend(CHAT, { text: 'second message' }, 'm2'))
    act(() => cache.writeNativeChatDraftCache(CHAT, '', 'now'))
    await act(async () => {})
    expect(saved()?.heldSends?.map((send) => send.clientMessageId)).toEqual(['m1', 'm2'])

    view.rerender({ status: 'ready', submissions: [] })
    await act(async () => {})

    // Only the earlier run's send goes back; this run's still waits for its host.
    expect(cache.readNativeChatDraftCache(CHAT)).toBe('sent once')
    expect(saved()?.heldSends?.map((send) => send.clientMessageId)).toEqual(['m2'])
  })
})

describe('a held send in a running session', () => {
  it('goes when the journal shows the host holds it, and stays while it is only pending', async () => {
    await store.write(CHAT, null)
    const { cache, heldSends, view } = await relaunch()
    act(() => heldSends.holdNativeChatDraftSend(CHAT, { text: 'live send' }, 'm3'))
    await act(async () => {})

    view.rerender({ status: 'ready', submissions: [submission('m3', 'pending')] })
    await act(async () => {})
    expect(saved()?.heldSends?.map((send) => send.text)).toEqual(['live send'])
    expect(cache.readNativeChatDraftCache(CHAT)).toBe('')

    view.rerender({ status: 'ready', submissions: [submission('m3', 'accepted')] })
    await act(async () => {})
    expect(saved()).toBeNull()
  })
})
