import { QueuedMessageUpdateParams } from '../../../../shared/rpc-contract/structured-agent-session-queued-edit-params'
import { queuedMessageWithEdit } from '../../../../shared/queued-message-edit'
// @vitest-environment happy-dom

// Exercise real edit lifecycle with a scripted host: preserve dirty text on departure and keep lease failures from blocking typing/Save/Cancel.

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, vi } from 'vitest'
import { toast } from 'sonner'
import type * as SonnerModule from 'sonner'
import type * as StructuredSessionClient from '@/runtime/structured-agent-session-client'
import type * as RendererI18n from '@/i18n/i18n'
import type { AgentJournalSubmission } from '../../../../shared/agent-session-journal-types'
import type {
  AgentSessionQueuedMessage,
  AgentSessionQueuedMessageEditHoldParams,
  AgentSessionQueuedMessageEditHoldResult,
  AgentSessionQueuedMessageUpdateResult
} from '../../../../shared/agent-session-wire'
import { agentSessionSendBodyFingerprint } from '../../../../shared/structured-agent-session-send-mutation'
import { useStructuredAgentSessionQueuedEdit } from './use-structured-agent-session-queued-edit'
import { projectQueuedMessageCards } from '../../../../shared/structured-agent-session-queued-cards'
import { clearNativeChatDraftCacheForTests } from './native-chat-draft-cache'
import {
  createMemoryNativeChatComposerDraftStorage,
  setNativeChatComposerDraftStorageForTests
} from './native-chat-composer-draft-storage'
import type {
  StructuredAgentSessionWrite,
  StructuredAgentSessionWriteOutcome
} from './use-structured-agent-session-mutate'

export const HELD: AgentSessionQueuedMessageEditHoldResult = {
  status: 'held',
  fingerprint: 'f'.repeat(64),
  leaseDurationMs: 120_000,
  remainingMs: 120_000
}
const hoistedRpc = vi.hoisted(() =>
  vi.fn(
    async (
      _target: unknown,
      _method: string,
      params: AgentSessionQueuedMessageEditHoldParams
    ): Promise<AgentSessionQueuedMessageEditHoldResult> =>
      params.action === 'release' ? { status: 'released' } : HELD
  )
)
export const rpc = hoistedRpc
const toastError = vi.hoisted(() => vi.fn<typeof SonnerModule.toast.error>())
vi.mock('@/runtime/structured-agent-session-client', async (importOriginal) => ({
  ...(await importOriginal<typeof StructuredSessionClient>()),
  callStructuredAgentSession: hoistedRpc
}))
vi.mock('sonner', async (importOriginal) => {
  const original = await importOriginal<typeof SonnerModule>()
  return {
    ...original,
    toast: Object.assign(
      function (this: unknown, ...args: Parameters<typeof original.toast>) {
        return original.toast.apply(this, args)
      },
      original.toast,
      { error: toastError }
    )
  }
})
vi.mock('@/i18n/i18n', async (importOriginal) => ({
  ...(await importOriginal<typeof RendererI18n>()),
  translate: (_key: string, fallback: string) => fallback
}))

export const SESSION = 'folder-session'
export const SCOPE = 'pane-draft'
export const message: AgentSessionQueuedMessage = {
  messageId: 'card',
  position: 2,
  state: 'waiting',
  body: {
    kind: 'message',
    role: 'user',
    blocks: [{ type: 'text', text: 'original' }],
    from: { kind: 'agent', senders: [], orchestration: null }
  }
}
export const BASE = agentSessionSendBodyFingerprint(SESSION, message.body)

export type Outcome = StructuredAgentSessionWriteOutcome<AgentSessionQueuedMessageUpdateResult>
export const script: { answer: () => Promise<Outcome> } = {
  answer: async () => ({ kind: 'dropped' })
}
export const writeSpy = vi.fn(async (..._args: unknown[]) => script.answer())
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this harness answers only queuedMessageUpdate, with that method's scripted outcome.
export const write = writeSpy as StructuredAgentSessionWrite

export type Props = {
  messages: AgentSessionQueuedMessage[] | null
  sessionId?: string
  submissions?: AgentJournalSubmission[]
  imagesCapable?: boolean
  skillsCapable?: boolean
  promptOpen?: boolean
}
export function harness(capable = true, initial: Props = { messages: [message] }) {
  return renderHook(
    (props: Props) => {
      const submissions = props.submissions ?? []
      return useStructuredAgentSessionQueuedEdit({
        transport: {
          target: { kind: 'environment', environmentId: 'remote-host' },
          sessionId: props.sessionId ?? SESSION,
          capable,
          imagesCapable: props.imagesCapable,
          skillsCapable: props.skillsCapable,
          write
        },
        messages: props.messages,
        cards: projectQueuedMessageCards(props.messages, submissions, {}),
        submissions,
        composerScopeKey: SCOPE,
        promptOpen: props.promptOpen ?? false
      })
    },
    { initialProps: initial }
  )
}
export type Hook = ReturnType<typeof harness>
export async function begin(hook: Hook) {
  await act(() => hook.result.current.begin('card'))
}
export function holdCalls(action: string) {
  return rpc.mock.calls.filter((call) => call[2].action === action)
}
export function done(value: AgentSessionQueuedMessageUpdateResult): () => Promise<Outcome> {
  return async () => ({ kind: 'done', value })
}
export function withText(text: string): AgentSessionQueuedMessage {
  return { ...message, body: { ...message.body, blocks: [{ type: 'text', text }] } }
}
export function submittedAs(text: string): AgentJournalSubmission {
  return {
    clientMessageId: 'submission',
    queuedMessageId: 'card',
    payloadFingerprint: agentSessionSendBodyFingerprint(SESSION, withText(text).body),
    fence: 3,
    dispatchState: 'pending',
    providerItemId: null,
    reason: null,
    submittedAt: 1,
    resolvedAt: null
  }
}

beforeEach(() => {
  rpc
    .mockReset()
    .mockImplementation(async (_target, _method, params) =>
      params.action === 'release' ? { status: 'released' } : HELD
    )
  writeSpy.mockClear()
  vi.mocked(toast.error).mockClear()
  clearNativeChatDraftCacheForTests()
  setNativeChatComposerDraftStorageForTests(createMemoryNativeChatComposerDraftStorage())
  script.answer = () =>
    Promise.resolve({
      kind: 'done',
      value: { status: 'updated', messageId: 'card', fingerprint: requestedFingerprint() }
    })
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

export function requestedFingerprint() {
  const fields = QueuedMessageUpdateParams.omit({ envelope: true }).parse(
    writeSpy.mock.calls.at(-1)?.[2]
  )
  const edited = queuedMessageWithEdit(message.body, fields)
  if (!edited.ok) {
    throw new Error(edited.reason)
  }
  return agentSessionSendBodyFingerprint(SESSION, edited.body)
}
