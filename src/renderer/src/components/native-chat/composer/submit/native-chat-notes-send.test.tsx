// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
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
import { useNativeChatPtyComposerSend } from './use-native-chat-pty-composer-send'
import type { NativeChatResolvedTarget } from './native-chat-composer-target'
import {
  readNativeChatAttachmentNotes,
  resetNativeChatAttachmentNotesForTests,
  setNativeChatAttachmentNotes
} from '../../media/notes/native-chat-attachment-notes'

vi.mock('@/components/native-chat/telemetry/native-chat-telemetry', () => ({
  emitNativeChatMessageSent: vi.fn()
}))
const runtimeSend = vi.hoisted(() => ({
  sendNativeChatMessage: vi.fn(() => ({})),
  sendNativeChatTypedCommand: vi.fn(() => ({})),
  sendWithImages: vi.fn(() => ({}))
}))
vi.mock('../../session/terminal/send/native-chat-runtime-image-send', () => ({
  sendNativeChatMessageWithImageAttachments: runtimeSend.sendWithImages
}))
vi.mock('../../session/terminal/send/native-chat-runtime-send', async (load) => ({
  ...(await load<object>()),
  sendNativeChatMessage: runtimeSend.sendNativeChatMessage,
  sendNativeChatTypedCommand: runtimeSend.sendNativeChatTypedCommand
}))

const NOTES = {
  mediaName: 'dashboard.png',
  source: { path: '/tmp/dashboard.png' },
  kind: 'image' as const,
  offset: 0,
  notes: [{ id: 'n1', number: 1, text: 'Align', mark: { kind: 'pin' as const, x: 0.5, y: 0.5 } }]
}

beforeEach(async () => {
  localStorage.clear()
  resetNativeChatAttachmentNotesForTests()
  clearNativeChatComposerDraftsForTests()
  setNativeChatComposerDraftStorageForTests(createMemoryNativeChatComposerDraftStorage())
  await hydrateNativeChatComposerDrafts()
  runtimeSend.sendWithImages.mockClear()
})
afterEach(() => cleanup())

it('a terminal command never carries a marked image’s notes, which stay for the next message (F2)', () => {
  setNativeChatAttachmentNotes('pane:notes', 'img-1', NOTES)
  const { result } = renderHook(() =>
    useNativeChatPtyComposerSend({
      agent: 'codex',
      draft: '/compact',
      draftScopeKey: 'pane:notes',
      imageAttachments: [{ id: 'img-1', path: '/tmp/marked.png' }],
      disabled: false,
      isDispatchingSessionOption: false,
      launchDraftResolved: true,
      resolveTarget: (): NativeChatResolvedTarget => ({ ptyId: 'pty-1' }),
      readTerminalDraft: () => '',
      classifySend: () => 'command',
      sessionOptionsSurface: null,
      terminalTabId: 'tab-1',
      trackPendingSend: vi.fn(),
      setDraft: vi.fn(),
      setCaret: vi.fn(),
      clearSkillOrigin: vi.fn(),
      clearImageAttachments: vi.fn(),
      setNotice: vi.fn()
    })
  )
  act(() => {
    result.current()
  })
  expect(runtimeSend.sendWithImages).toHaveBeenCalledWith(
    'codex',
    'pty-1',
    '/compact',
    ['/tmp/marked.png'],
    expect.anything()
  )
})

it('a structured send that is refused after going pending keeps the images’ notes (F4)', async () => {
  const scope = 'agent-session:notes'
  setNativeChatAttachmentNotes(scope, 'img-1', NOTES)
  const transport: NativeChatStructuredComposerTransport = {
    capturePresentation: () => () => true,
    // A transport that answers later, as a bot group chat does; the answer is a refusal.
    send: vi.fn(async () => false),
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
    runtime: 'local',
    sessionId: 'notes',
    runtimeEnvironmentId: null
  }
  const { result } = renderHook(() => {
    const draft = useNativeChatDraft(scope, () => false)
    return useNativeChatStructuredComposerSend({
      agent: 'codex',
      draftScopeKey: scope,
      imageAttachments: [{ id: 'img-1', path: '/tmp/marked.png' }],
      structuredTransport: transport,
      isComposing: () => false,
      clearSkillOrigin: vi.fn(),
      setDraft: draft.setDraft,
      setCaret: vi.fn()
    })
  })
  await act(async () => {
    await result.current('Please fix', [{ id: 'img-1', path: '/tmp/marked.png' }])
  })
  expect(transport.send).toHaveBeenCalledWith(
    expect.stringContaining('1. Align'),
    expect.anything()
  )
  expect(readNativeChatAttachmentNotes(scope, 'img-1')?.notes).toHaveLength(1)
})
