// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useNativeChatStructuredComposerSend } from './use-native-chat-structured-composer-send'
import type { NativeChatStructuredComposerTransport } from './native-chat-structured-composer-transport'
import { useNativeChatDraft } from '../../drafts/use-native-chat-draft'
import { clearNativeChatComposerDraftsForTests } from '../../drafts/native-chat-draft-reset'
import { updateNativeChatComposerDraft } from '../../drafts/native-chat-composer-draft-store'
import type { PipelineV2BoundSessionResult } from '../../../../../../shared/pipelines/v2/pipeline-v2-session-contracts'

vi.mock('@/components/native-chat/telemetry/native-chat-telemetry', () => ({
  emitNativeChatMessageSent: vi.fn()
}))
const scope = 'agent-session:pipeline-discussion'
const originalApi = Object.getOwnPropertyDescriptor(window, 'api')
beforeEach(() => {
  clearNativeChatComposerDraftsForTests()
  updateNativeChatComposerDraft(scope, { text: 'Explain rollback' }, 'immediate')
})
afterEach(() => {
  cleanup()
  clearNativeChatComposerDraftsForTests()
  if (originalApi) {
    Object.defineProperty(window, 'api', originalApi)
  } else {
    Reflect.deleteProperty(window, 'api')
  }
})
function fixture(send: () => Promise<PipelineV2BoundSessionResult>) {
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { pipelineOwner: { discussBoundSession: send } }
  })
  const messages: string[] = []
  const transport: NativeChatStructuredComposerTransport = {
    capturePresentation: () => () => true,
    send: (text) => {
      messages.push(text)
      return true
    },
    dispatchCommand: async () => ({ handled: false, accepted: false, error: null }),
    optionsSurface: {
      getSnapshot: () => [],
      setOption: vi.fn(),
      invokeAction: vi.fn(),
      subscribe: () => () => {}
    },
    optionSnapshot: [],
    onError: vi.fn(),
    runtime: 'local',
    runtimeEnvironmentId: null,
    sessionId: 'pipeline-discussion'
  }
  const hook = renderHook(() => {
    const draft = useNativeChatDraft(scope, () => false)
    const send = useNativeChatStructuredComposerSend({
      agent: 'codex',
      draftScopeKey: scope,
      imageAttachments: [],
      structuredTransport: transport,
      isComposing: () => false,
      clearSkillOrigin: () => {},
      setDraft: draft.setDraft,
      setCaret: () => {}
    })
    return { draft, send }
  })
  return { hook, messages }
}
it('keeps_the_real_chat_draft_until_managed_delivery_and_never_sends_the_original_transport_again', async () => {
  const delivery = Promise.withResolvers<PipelineV2BoundSessionResult>()
  const { hook, messages } = fixture(() => delivery.promise)
  let pending!: Promise<boolean>
  act(() => {
    pending = hook.result.current.send('Explain rollback')
  })
  expect(hook.result.current.draft.draft).toBe('Explain rollback')
  await act(async () => {
    delivery.resolve({ handled: true, accepted: true })
    expect(await pending).toBe(true)
  })
  expect(hook.result.current.draft.draft).toBe('')
  expect(messages).toEqual([])
})
it('retains_the_draft_on_unconfirmed_managed_delivery', async () => {
  const { hook, messages } = fixture(async () => ({ handled: true, accepted: false }))
  await act(async () => {
    expect(await hook.result.current.send('Explain rollback')).toBe(false)
  })
  expect(hook.result.current.draft.draft).toBe('Explain rollback')
  expect(messages).toEqual([])
})
