// @vitest-environment happy-dom
// A remote reply whose staged file is still uploading: the production sender holds the reservation
// while the upload runs, so the reply's original must survive a return or drop in that window.
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearNativeChatComposerDraftsForTests } from '../../drafts/native-chat-draft-reset'
import { hydrateNativeChatComposerDrafts } from '../../drafts/native-chat-composer-draft-load'
import {
  createMemoryNativeChatComposerDraftStorage,
  setNativeChatComposerDraftStorageForTests
} from '../../drafts/native-chat-composer-draft-storage'
import { useNativeChatDraft } from '../../drafts/use-native-chat-draft'
import { dispatchStructuredAgentSessionComposerCommand } from '../../../../../../shared/agent-session/view/structured-agent-session-composer'
import type { NativeChatStructuredComposerTransport } from './native-chat-structured-composer-transport'
import { useNativeChatStructuredComposerSend } from './use-native-chat-structured-composer-send'
import {
  nativeChatReplyTargetFromSentText,
  resetNativeChatReplyTargetsForTests,
  setNativeChatReplyTarget
} from '../reply/native-chat-reply-target'
import { withNativeChatReplyContext } from '../reply/native-chat-reply-quote'
import {
  nativeChatReplySourceOf,
  resetNativeChatReplySourcesForTests
} from '../reply/native-chat-reply-sources'
import { nativeChatReplyRevealId } from '../reply/native-chat-reply-original'
import {
  dropStructuredAgentSessionSends,
  resetStructuredAgentSessionSendsForTests,
  sendStructuredAgentSessionMessage,
  stopStructuredAgentSessionSends
} from '../../session/structured/delivery/structured-agent-session-message-sender'
import { noteStructuredAgentSessionFence } from '../../session/structured/delivery/structured-agent-session-send-attempt'

const mocks = vi.hoisted(() => ({
  call: vi.fn(),
  handBack: vi.fn((..._args: unknown[]): boolean => true),
  // Each upload waits here, at the transport boundary, until the test settles it.
  uploads: [] as { finish: () => void; fail: () => void }[]
}))

vi.mock('@/runtime/native-chat/requests/structured-agent-session-call', () => ({
  callStructuredAgentSession: mocks.call
}))
vi.mock('@/runtime/native-chat/host-capabilities/structured-agent-session-host-support', () => ({
  structuredAgentSessionHostSupports: vi.fn(async () => true)
}))
vi.mock('../../session/structured/delivery/structured-agent-session-message-hand-back', () => ({
  handBackStructuredAgentSessionMessage: mocks.handBack
}))
vi.mock('../../drafts/native-chat-draft-attachment-staging', async (load) => ({
  ...(await load<object>()),
  hasNativeChatStagedFiles: () => true,
  // A remote host keeps staged files elsewhere: preparing rewrites their paths in the message.
  captureNativeChatStagedInput: () => ({
    release: () => {},
    prepare: <T extends { text: string }>(input: T): Promise<T> =>
      new Promise<T>((resolve, reject) => {
        mocks.uploads.push({
          finish: () =>
            resolve({ ...input, text: input.text.replaceAll('/local/', '/host/uploads/') }),
          fail: () => reject(new Error('upload failed'))
        })
      })
  })
}))
vi.mock('@/components/native-chat/telemetry/native-chat-telemetry', () => ({
  emitNativeChatMessageSent: vi.fn()
}))

const SESSION = 'reply'
const scope = 'agent-session:reply'
const excerpt = 'Updated the three cards.\nThe Continue button is blue now.'
const words = 'Check /local/spec.md here'
// Same-author duplicates: A and B have the same words, so only a recorded id tells them apart.
const A = 'm-a'
const B = 'm-b'
const duplicates = [A, B].map((id) => ({
  id,
  role: 'assistant' as const,
  blocks: [{ type: 'text' as const, text: excerpt }]
}))
const admitted = withNativeChatReplyContext(words, { author: 'agent', excerpt }, 'Codex')
const prepared = admitted.replaceAll('/local/', '/host/uploads/')

function fixture() {
  const transport: NativeChatStructuredComposerTransport = {
    capturePresentation: () => () => true,
    // As the chat's send hook does: the production sender reserves the send, then prepares it.
    send: (text, attachments, request) => {
      const sent = sendStructuredAgentSessionMessage({
        sessionId: SESSION,
        target: { kind: 'local' },
        text,
        attachments: attachments.map(({ path }) => ({ path, previewUri: '' })),
        ...(request?.prepareAttachments ? { prepareAttachments: request.prepareAttachments } : {})
      })
      if (!sent) {
        return false
      }
      if (request?.onSettled) {
        void sent.outcome.then(request.onSettled)
      }
      return true
    },
    dispatchCommand: (text) =>
      dispatchStructuredAgentSessionComposerCommand(text, {
        agent: 'codex',
        snapshot: [],
        invokeAction: async () => true,
        setOption: async () => true
      }),
    optionsSurface: {
      getSnapshot: () => [],
      setOption: vi.fn(),
      invokeAction: vi.fn(),
      subscribe: () => () => {}
    },
    optionSnapshot: [],
    onError: vi.fn(),
    runtime: 'remote',
    sessionId: SESSION,
    runtimeEnvironmentId: null
  }
  const hook = renderHook(() => {
    const draft = useNativeChatDraft(scope, () => false)
    return useNativeChatStructuredComposerSend({
      agent: 'codex',
      draftScopeKey: scope,
      imageAttachments: [],
      structuredTransport: transport,
      isComposing: () => false,
      clearSkillOrigin: vi.fn(),
      setDraft: draft.setDraft,
      setCaret: vi.fn()
    })
  })
  return async (messageId: string): Promise<void> => {
    setNativeChatReplyTarget(scope, {
      id: `reply-${messageId}`,
      messageId,
      author: 'agent',
      excerpt
    })
    await act(async () => {
      expect(await hook.result.current(words)).toBe(true)
    })
  }
}

async function flush(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 10; index += 1) {
      await Promise.resolve()
    }
  })
}

const dispatchedBodies = (): string[] =>
  mocks.call.mock.calls
    .filter((call) => call[1] === 'agentSession.send')
    .map((call) =>
      (call[2] as { body: { blocks: { type: string; text?: string }[] } }).body.blocks
        .flatMap((block) => (block.type === 'text' && block.text ? [block.text] : []))
        .join('\n')
    )

const returnedText = (): string => {
  const body = mocks.handBack.mock.calls.at(-1)?.[2] as {
    blocks: { type: string; text?: string }[]
  }
  return body.blocks.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n')
}

/** What Rewind or Edit opens for text read back in this chat, with only `loaded` messages present. */
function reveals(text: string, loaded: readonly string[]): string | null {
  const rebuilt = nativeChatReplyTargetFromSentText(text, scope).target!
  return nativeChatReplyRevealId(
    rebuilt,
    (id) => loaded.includes(id),
    () => duplicates.filter((message) => loaded.includes(message.id))
  )
}

describe('a staged reply while its upload is pending', () => {
  beforeEach(async () => {
    localStorage.clear()
    mocks.call.mockReset()
    mocks.handBack.mockClear()
    mocks.uploads.length = 0
    mocks.call.mockImplementation(
      (_target, method: string, params: { clientOperationId?: string }) =>
        method === 'agentSession.send'
          ? Promise.resolve({
              ok: true,
              replayed: false,
              fence: 4,
              cursor: { epoch: 'e', sequence: 1 },
              value: {
                clientMessageId: params.clientOperationId,
                submission: {
                  clientMessageId: params.clientOperationId,
                  dispatchState: 'accepted',
                  submittedAt: 1
                }
              }
            })
          : new Promise(() => {})
    )
    noteStructuredAgentSessionFence(SESSION, 4)
    resetNativeChatReplyTargetsForTests()
    resetNativeChatReplySourcesForTests()
    clearNativeChatComposerDraftsForTests()
    setNativeChatComposerDraftStorageForTests(createMemoryNativeChatComposerDraftStorage())
    await hydrateNativeChatComposerDrafts()
  })
  afterEach(() => {
    resetStructuredAgentSessionSendsForTests()
    cleanup()
    clearNativeChatComposerDraftsForTests()
  })

  it('comes back as the reply to A when preparing fails after admission', async () => {
    const send = fixture()
    await send(A)
    mocks.uploads[0]!.fail()
    await flush()
    expect(mocks.handBack).toHaveBeenCalledTimes(1)
    expect(returnedText()).toBe(admitted)
    expect(reveals(returnedText(), [A, B])).toBe(A)
    // Only the duplicate loaded: unavailable, never B.
    expect(reveals(returnedText(), [B])).toBeNull()
    expect(dispatchedBodies()).toEqual([])
  })

  it('comes back as the reply to A when stopped mid-upload, and a late upload neither sends nor records', async () => {
    const send = fixture()
    await send(A)
    stopStructuredAgentSessionSends(SESSION)
    await flush()
    expect(returnedText()).toBe(admitted)
    expect(reveals(returnedText(), [A, B])).toBe(A)
    expect(reveals(returnedText(), [B])).toBeNull()
    mocks.uploads[0]!.finish()
    await flush()
    expect(dispatchedBodies()).toEqual([])
    expect(nativeChatReplySourceOf(scope, prepared)).toBeUndefined()

    // The same prepared words then sent in reply to B open B, not a stale A.
    await send(B)
    mocks.uploads[1]!.finish()
    await flush()
    expect(dispatchedBodies()).toEqual([prepared])
    expect(nativeChatReplySourceOf(scope, prepared)).toBe(B)
    expect(reveals(prepared, [A, B])).toBe(B)
  })

  it('a reservation dropped mid-upload neither sends nor records the prepared words', async () => {
    const send = fixture()
    await send(A)
    dropStructuredAgentSessionSends(SESSION)
    mocks.uploads[0]!.finish()
    await flush()
    expect(dispatchedBodies()).toEqual([])
    expect(nativeChatReplySourceOf(scope, prepared)).toBeUndefined()
  })

  it('a finished upload sends the prepared words, rebuilt as the reply to A', async () => {
    const send = fixture()
    await send(A)
    mocks.uploads[0]!.finish()
    await flush()
    const [body] = dispatchedBodies()
    expect(body).toBe(prepared)
    expect(reveals(body!, [A, B])).toBe(A)
    expect(reveals(body!, [B])).toBeNull()
  })
})
