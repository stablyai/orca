// @vitest-environment happy-dom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useNativeChatPtyComposerSend } from './use-native-chat-pty-composer-send'
import { useNativeChatDraft } from '../../drafts/use-native-chat-draft'
import { clearNativeChatComposerDraftsForTests } from '../../drafts/native-chat-draft-reset'
import { updateNativeChatComposerDraft } from '../../drafts/native-chat-composer-draft-store'
import type { PipelineV2BoundSessionResult } from '../../../../../../shared/pipelines/v2/pipeline-v2-session-contracts'

const rawDelivery = vi.hoisted(() => vi.fn())
vi.mock('../../session/terminal/send/native-chat-runtime-send', () => ({
  sendNativeChatMessage: rawDelivery,
  sendNativeChatTypedCommand: vi.fn(),
  submitNativeChatPrompt: vi.fn()
}))

vi.mock('@/components/native-chat/telemetry/native-chat-telemetry', () => ({
  emitNativeChatMessageSent: () => {}
}))
const originalApi = Object.getOwnPropertyDescriptor(window, 'api')
afterEach(() => {
  vi.clearAllMocks()
  cleanup()
  clearNativeChatComposerDraftsForTests()
  if (originalApi) {
    Object.defineProperty(window, 'api', originalApi)
  } else {
    Reflect.deleteProperty(window, 'api')
  }
})
it('delivers an ordinary message once when submit repeats before the pipeline probe returns', async () => {
  const scope = 'ordinary-pty-probe-draft'
  updateNativeChatComposerDraft(scope, { text: 'Explain this ordinary task' }, 'immediate')
  const probe = Promise.withResolvers<PipelineV2BoundSessionResult>()
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { pipelineOwner: { discussBoundSession: () => probe.promise } }
  })
  const hook = renderHook(() => {
    const draft = useNativeChatDraft(scope, () => false)
    return useNativeChatPtyComposerSend({
      agent: 'codex',
      draft: draft.draft,
      draftScopeKey: scope,
      imageAttachments: [],
      disabled: false,
      isDispatchingSessionOption: false,
      launchDraftResolved: true,
      resolveTarget: () => ({ ptyId: 'ordinary-pty-probe' }),
      classifySend: () => 'chat',
      sessionOptionsSurface: null,
      terminalTabId: 'ordinary-pty-tab',
      trackPendingSend: () => {},
      setDraft: draft.setDraft,
      setCaret: () => {},
      clearSkillOrigin: () => {},
      clearImageAttachments: () => {},
      setNotice: () => {}
    })
  })
  act(() => {
    hook.result.current()
    hook.result.current()
  })
  await act(async () => {
    probe.resolve({ handled: false, accepted: false })
  })
  expect(rawDelivery.mock.calls.map((call) => call.slice(0, 2))).toEqual([
    ['ordinary-pty-probe', 'Explain this ordinary task']
  ])
})
it('keeps the PTY chat draft through unknown delivery and clears it only after the same send is confirmed', async () => {
  const scope = 'pipeline-pty-chat-draft'
  updateNativeChatComposerDraft(scope, { text: 'Уточни порядок округления скидки.' }, 'immediate')
  let delivery = Promise.withResolvers<PipelineV2BoundSessionResult>()
  const inputs: { requestId: string; message: string }[] = []
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      pipelineOwner: {
        discussBoundSession: (input: { requestId: string; message: string }) => {
          inputs.push(input)
          return delivery.promise
        }
      }
    }
  })
  let notice: string | null = null
  const hook = renderHook(() => {
    const draft = useNativeChatDraft(scope, () => false)
    const send = useNativeChatPtyComposerSend({
      agent: 'codex',
      draft: draft.draft,
      draftScopeKey: scope,
      imageAttachments: [],
      disabled: false,
      isDispatchingSessionOption: false,
      launchDraftResolved: true,
      resolveTarget: () => ({ ptyId: 'pipeline-pty-test' }),
      classifySend: () => 'chat',
      sessionOptionsSurface: null,
      terminalTabId: 'pipeline-pty-tab',
      trackPendingSend: () => {},
      setDraft: draft.setDraft,
      setCaret: () => {},
      clearSkillOrigin: () => {},
      clearImageAttachments: () => {},
      setNotice: (value) => {
        notice = value
      }
    })
    return { draft, send }
  })
  act(() => {
    expect(hook.result.current.send()).toBe(true)
  })
  expect(hook.result.current.draft.draft).toBe('Уточни порядок округления скидки.')
  await act(async () => {
    delivery.resolve({ handled: true, accepted: false, receipt: { state: 'outcome_unknown' } })
  })
  await waitFor(() => expect(notice).toContain('unconfirmed'))
  expect(hook.result.current.draft.draft).toBe('Уточни порядок округления скидки.')
  delivery = Promise.withResolvers<PipelineV2BoundSessionResult>()
  act(() => {
    hook.result.current.send()
  })
  await act(async () => {
    delivery.resolve({ handled: true, accepted: true, receipt: { state: 'ready' } })
  })
  await waitFor(() => expect(hook.result.current.draft.draft).toBe(''))
  expect(inputs.map((input) => input.requestId)).toEqual([inputs[0].requestId, inputs[0].requestId])
  expect(inputs[1].message).toBe('Уточни порядок округления скидки.')
})
