// @vitest-environment happy-dom
import { renderHook } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import type { StructuredAgentSessionSendRequest } from '../../session/structured/delivery/structured-agent-session-send-slot'
import type { NativeChatStructuredComposerTransport } from './native-chat-structured-composer-transport'

// Telemetry is the only stand-in. The composer send, its admission, staging, the draft store and the
// hand-back run for real; the transport records what would leave and plays the sender's part.
vi.mock('@/components/native-chat/telemetry/native-chat-telemetry', () => ({
  emitNativeChatMessageSent: () => {}
}))

const { useNativeChatStructuredComposerSend } =
  await import('./use-native-chat-structured-composer-send')
const { readNativeChatComposerDraft, updateNativeChatComposerDraft } =
  await import('../../drafts/native-chat-composer-draft-store')
const { stageNativeChatDraftFile } =
  await import('../../drafts/native-chat-draft-attachment-staging')
const { captureNativeChatStagedInput } = await import('../../drafts/native-chat-staged-input')
const { structuredAgentSessionDraftScopeKey } = await import('../../drafts/native-chat-draft-scope')
const { returnMessageToComposer } =
  await import('../../session/structured/delivery/structured-agent-session-message-hand-back')
const { formatNativeChatFileReference } =
  await import('../../../../../../shared/native-chat/input/composer/agent-image-paste')
const { nativeChatBrowserFileRefusalParts } =
  await import('../../attachments/native-chat-browser-file-references')
const { agentSessionWriteNoticeText } =
  await import('../../messages/notices/agent-session-write-notice-text')

type Sent = { text: string; request?: StructuredAgentSessionSendRequest }

/** A structured transport whose `send` plays the sender: `onSend` runs where the real one reserves. */
function composer(sessionId: string, onSend: (sent: Sent) => void = () => {}) {
  const sends: Sent[] = []
  const errors: (string | null)[] = []
  const fields = {
    sessionId,
    runtime: 'local',
    runtimeEnvironmentId: null,
    optionSnapshot: [],
    capturePresentation: () => () => true,
    onError: (message: string | null) => errors.push(message),
    dispatchCommand: async () => ({ handled: false, accepted: false, error: null }),
    send: (text: string, _attachments: unknown, request?: StructuredAgentSessionSendRequest) => {
      const sent = { text, ...(request ? { request } : {}) }
      sends.push(sent)
      onSend(sent)
      return true
    }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fields this send reads.
  const transport = fields as unknown as NativeChatStructuredComposerTransport
  const scope = structuredAgentSessionDraftScopeKey(sessionId)
  const { result } = renderHook(() =>
    useNativeChatStructuredComposerSend({
      agent: 'codex',
      draftScopeKey: scope,
      imageAttachments: [],
      structuredTransport: transport,
      isComposing: () => false,
      clearSkillOrigin: () => {},
      setDraft: (text) => updateNativeChatComposerDraft(scope, { text }, 'immediate'),
      setCaret: () => {}
    })
  )
  return { scope, sends, errors, send: result.current }
}

/** The scope also stages a file this message doesn't name, under an active send lease of its own. */
function unrelatedStaging(scope: string, name: string): void {
  const unrelated = `orca-browser-file:${name}/unrelated.png`
  stageNativeChatDraftFile(scope, unrelated)
  captureNativeChatStagedInput(scope, { text: '', attachments: [{ path: unrelated }] })
}

beforeEach(() => {
  localStorage.clear()
})

// D11-02 / C15-02. A text-only reference to a browser file this draft doesn't stage (a stale copy),
// in a scope with unrelated staging: the message gets no preparation, so it is refused in place before
// anything leaves. The draft keeps exactly its text and document, and later typing stays.
it('refuses an unstaged reference in place even with unrelated staging in the scope', async () => {
  const { scope, sends, errors, send } = composer('ownership-free-slot')
  unrelatedStaging(scope, 'free-slot')
  const stale = 'orca-browser-file:stale/old.png'
  const text = `look at ${formatNativeChatFileReference(stale)}`
  const document = {
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }]
  }
  updateNativeChatComposerDraft(scope, { text, document }, 'immediate')
  const before = readNativeChatComposerDraft(scope)

  expect(await send(text, [])).toBe(false)

  expect(sends).toEqual([])
  expect(readNativeChatComposerDraft(scope)).toBe(before)
  expect(errors.at(-1)).toBe(
    agentSessionWriteNoticeText(nativeChatBrowserFileRefusalParts([stale]))
  )
  updateNativeChatComposerDraft(scope, { text: `${text} and more` }, 'immediate')
  await Promise.resolve()
  expect(readNativeChatComposerDraft(scope).text).toBe(`${text} and more`)
})

// The ordering control. A staged send that is refused locally, immediately or a tick later, hands its
// unchanged text back. The draft became the send's when the send was made, so the returned text lands
// in an emptied draft once, and is never merged into the still-held draft and then erased by cleanup.
it.each(['immediate', 'delayed'] as const)(
  'keeps a staged send refused %s by its own hand-back',
  async (timing) => {
    const sessionId = `ownership-${timing}`
    const scope = structuredAgentSessionDraftScopeKey(sessionId)
    const original = `orca-browser-file:${timing}/shot.png`
    stageNativeChatDraftFile(scope, original)
    const text = `see ${formatNativeChatFileReference(original)}`
    updateNativeChatComposerDraft(scope, { text }, 'immediate')
    let draftAtCreate: string | undefined
    const handBack = (): void => {
      returnMessageToComposer(scope, `returned-${timing}`, [{ type: 'text', text }])
    }
    const { sends, send } = composer(sessionId, ({ request }) => {
      request?.onCreated?.('id')
      draftAtCreate = readNativeChatComposerDraft(scope).text
      if (timing === 'immediate') {
        handBack()
      } else {
        void Promise.resolve().then(handBack)
      }
    })

    expect(await send(text, [])).toBe(true)
    await Promise.resolve()
    await Promise.resolve()

    expect(sends).toHaveLength(1)
    expect(sends[0].request?.prepareAttachments).toBeDefined()
    expect(draftAtCreate).toBe('')
    expect(readNativeChatComposerDraft(scope).text).toBe(text)
  }
)

// The healthy control: a staged send naming its own original is admitted with its preparation, and
// the composer is cleared once.
it('admits a staged send naming its own original, with a preparation', async () => {
  const sessionId = 'ownership-healthy'
  const scope = structuredAgentSessionDraftScopeKey(sessionId)
  const original = 'orca-browser-file:healthy/shot.png'
  stageNativeChatDraftFile(scope, original)
  const text = `see ${formatNativeChatFileReference(original)}`
  updateNativeChatComposerDraft(scope, { text }, 'immediate')
  const { sends, errors, send } = composer(sessionId)

  expect(await send(text, [])).toBe(true)

  expect(sends.map(({ text: sent }) => sent)).toEqual([text])
  expect(sends[0].request?.prepareAttachments).toBeDefined()
  expect(errors.filter((error) => error !== null)).toEqual([])
  expect(readNativeChatComposerDraft(scope).text).toBe('')
})

// Alternate Queue (Cmd/Ctrl+Enter) meets the same admission: refused in place, nothing sent.
it('refuses an unstaged reference in place for an alternate Queue send', async () => {
  const { scope, sends, send } = composer('ownership-queue')
  unrelatedStaging(scope, 'queue')
  const text = `queue ${formatNativeChatFileReference('orca-browser-file:q/old.png')}`
  updateNativeChatComposerDraft(scope, { text }, 'immediate')

  expect(await send(text, [], { alternate: true })).toBe(false)
  expect(sends).toEqual([])
  expect(readNativeChatComposerDraft(scope).text).toBe(text)
})
