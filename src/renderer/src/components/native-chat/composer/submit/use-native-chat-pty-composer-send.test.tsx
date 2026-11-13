// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useNativeChatPtyComposerSend } from './use-native-chat-pty-composer-send'
import { useNativeChatPendingDelivery } from '../../session/terminal/delivery/use-native-chat-pending-delivery'
import { clearPendingSendCacheForTests } from '../../session/terminal/delivery/native-chat-pending'
import { pendingSendsAsMessages } from '../../../../../../shared/native-chat/transcript/native-chat-pending-sends'

const mocks = vi.hoisted(() => ({ host: vi.fn(), image: vi.fn(), text: vi.fn() }))
vi.mock('../../session/terminal/send/native-chat-host-prompt', () => ({
  sendNativeChatHostPrompt: mocks.host
}))
vi.mock('../../session/terminal/send/native-chat-runtime-image-send', () => ({
  sendNativeChatMessageWithImageAttachments: mocks.image
}))
vi.mock('../../session/terminal/send/native-chat-runtime-send', () => ({
  sendNativeChatMessage: mocks.text,
  sendNativeChatTypedCommand: vi.fn(),
  submitNativeChatPrompt: vi.fn()
}))
vi.mock('../../drafts/native-chat-composer-draft-store', () => ({
  readNativeChatComposerDraft: () => ({})
}))
vi.mock('../pickers/native-chat-agent-reference-send', () => ({
  serializeNativeChatAgentReferences: (text: string) => text
}))
vi.mock('../../paste/native-chat-composer-pasted-text-references', () => ({
  admitNativeChatPastedText: () => true,
  resolveNativeChatPastedText: (_scope: string, text: string) => text
}))
vi.mock('../../drafts/native-chat-launch-draft-send', () => ({
  resolveNativeChatLaunchDraftSend: () => ({ sendOptions: {} })
}))
vi.mock('../../telemetry/native-chat-telemetry', () => ({ emitNativeChatMessageSent: vi.fn() }))
vi.mock('@/store/index', () => ({
  useAppStore: Object.assign(
    (selector: (state: { agentStatusByPaneKey: object }) => unknown) =>
      selector({ agentStatusByPaneKey: {} }),
    { getState: () => ({ tabsByWorktree: {}, clearNativeChatLaunchDraft: vi.fn() }) }
  )
}))

beforeEach(() => {
  vi.clearAllMocks()
  clearPendingSendCacheForTests()
  const handle = { cancel: vi.fn(), settleAfterMs: 0 }
  mocks.host.mockReturnValue(handle)
  mocks.image.mockReturnValue(handle)
})
afterEach(cleanup)

const emptySession = { messages: [] }

function composer(draft: string) {
  const hook = renderHook(() => {
    const delivery = useNativeChatPendingDelivery({
      paneKey: 'pane',
      agent: 'codex',
      session: emptySession
    })
    const send = useNativeChatPtyComposerSend({
      agent: 'codex',
      draft,
      draftScopeKey: 'pane',
      imageAttachments: [{ path: '/tmp/original.png' }],
      disabled: false,
      isDispatchingSessionOption: false,
      launchDraftResolved: true,
      resolveTarget: () => ({ ptyId: 'pty', paneKey: 'pane' }),
      classifySend: () => 'chat',
      onOptimisticSend: delivery.record,
      optimisticSendOutcome: delivery,
      sessionOptionsSurface: null,
      terminalTabId: 'tab',
      trackPendingSend: vi.fn(),
      setDraft: vi.fn(),
      setCaret: vi.fn(),
      clearSkillOrigin: vi.fn(),
      clearImageAttachments: vi.fn(),
      setNotice: vi.fn()
    })
    return { send, messages: pendingSendsAsMessages(delivery.pending) }
  })
  return { hook }
}

it.each(['', 'caption', '/model'])(
  'keeps image send %j on the shipped attachment writer',
  (text) => {
    const { hook } = composer(text)
    act(() => expect(hook.result.current.send()).toBe(true))
    expect(mocks.image).toHaveBeenCalledWith('codex', 'pty', text, ['/tmp/original.png'], {})
    expect(mocks.host).not.toHaveBeenCalled()
    expect(hook.result.current.messages[0].blocks).toEqual([
      { type: 'image-ref', path: '/tmp/original.png' },
      ...(text ? [{ type: 'text', text }] : [])
    ])
  }
)

it('uses the retry attachments rather than the current draft to choose the writer', () => {
  const { hook } = composer('unsent draft')
  act(() =>
    expect(hook.result.current.send({ text: 'retry', imagePaths: ['/tmp/retry.png'] })).toBe(true)
  )
  expect(mocks.image).toHaveBeenCalledWith('codex', 'pty', 'retry', ['/tmp/retry.png'], {})
  expect(mocks.host).not.toHaveBeenCalled()
  expect(hook.result.current.messages[0].blocks).toEqual([
    { type: 'image-ref', path: '/tmp/retry.png' },
    { type: 'text', text: 'retry' }
  ])
  act(() => expect(hook.result.current.send({ text: 'text retry' })).toBe(true))
  expect(mocks.host).toHaveBeenCalledWith(
    expect.objectContaining({ prompt: { agent: 'codex', text: 'text retry' } })
  )
  expect(hook.result.current.messages.at(-1)?.blocks).toEqual([
    { type: 'text', text: 'text retry' }
  ])
})
