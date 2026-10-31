// @vitest-environment happy-dom

import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { ManagedRuntimeInstallObservation } from '@/runtime/use-managed-runtime-install'

const { mocks, moduleFactories, resetStructuredSessionMocks } = await vi.hoisted(async () =>
  (await import('./NativeChatStructuredSession.test-harness')).createStructuredSessionMocks()
)
const install = vi.hoisted((): { observation: ManagedRuntimeInstallObservation } => ({
  observation: { kind: 'inactive' }
}))

vi.mock('@/lib/structured-agent-session-launch', () =>
  moduleFactories.structuredAgentSessionLaunch()
)
vi.mock('@/lib/structured-agent-session-launch-message', () =>
  moduleFactories.structuredAgentSessionLaunchMessage()
)
vi.mock('@/runtime/structured-agent-session-client', () =>
  moduleFactories.structuredAgentSessionClient()
)
vi.mock('./use-structured-agent-session', () => moduleFactories.useStructuredAgentSession())
vi.mock('./use-native-chat-font-size', () => moduleFactories.useNativeChatFontSize())
vi.mock('./use-native-chat-file-link-context', () => moduleFactories.useNativeChatFileLinkContext())
vi.mock('./use-native-chat-tab-owner', () => moduleFactories.useNativeChatTabOwner())
vi.mock('./use-native-chat-file-link-click', () => moduleFactories.useNativeChatFileLinkClick())
vi.mock('./NativeChatMessageList', () => moduleFactories.nativeChatMessageList())
vi.mock('./NativeChatEmptyState', () => moduleFactories.nativeChatEmptyState())
vi.mock('./NativeChatApprovalCard', () => moduleFactories.nativeChatApprovalCard())
vi.mock('./NativeChatQuestionCard', () => moduleFactories.nativeChatQuestionCard())
vi.mock('@/runtime/use-managed-runtime-install', () => ({
  useManagedRuntimeInstall: () => install.observation
}))

import { NativeChatStructuredSession } from './NativeChatStructuredSession'
import {
  clearNativeChatComposerDraftsForTests,
  hydrateNativeChatComposerDrafts,
  readNativeChatComposerDraft,
  structuredAgentSessionDraftScopeKey,
  updateNativeChatComposerDraft
} from './native-chat-composer-draft-store'

import { TooltipProvider } from '@/components/ui/tooltip'
import { promptEditor } from './native-chat-prompt-editor.test-support'
import { promptTextContent } from './native-chat-prompt-document-text'
import {
  createMemoryNativeChatComposerDraftStorage,
  setNativeChatComposerDraftStorageForTests
} from './native-chat-composer-draft-storage'

afterEach(() => {
  cleanup()
  resetStructuredSessionMocks()
  clearNativeChatComposerDraftsForTests()
})
it('shows and copies the ordinary source of an unsupported installed launch', async () => {
  const text = 'Hand Off context\nwith trailing bytes  '
  clearNativeChatComposerDraftsForTests()
  setNativeChatComposerDraftStorageForTests(createMemoryNativeChatComposerDraftStorage())
  await hydrateNativeChatComposerDrafts()
  mocks.launchLifecycle = 'failed'
  mocks.launchFailure = { kind: 'refused', code: 'structured_agent_session_unsupported' }
  mocks.messages = []
  install.observation = {
    kind: 'active',
    subject: { target: { kind: 'local' }, runtimeId: null, agent: 'codex' },
    snapshot: {
      kind: 'known',
      state: {
        agent: 'codex',
        revision: 1,
        available: true,
        version: '1.3.0',
        installedVersion: '1.3.0',
        installedCurrent: true,
        downloadBytes: 0,
        source: 'external',
        operation: null
      }
    },
    removable: false
  }
  updateNativeChatComposerDraft(
    structuredAgentSessionDraftScopeKey('session-1'),
    { text, document: promptTextContent(text) },
    'immediate'
  )
  render(
    <TooltipProvider>
      <NativeChatStructuredSession
        isVisible
        isFocusedGroup
        tabId="structured-tab-1"
        sessionId="session-1"
        target={{ kind: 'local' }}
        agent="codex"
      />
    </TooltipProvider>
  )
  const field = await screen.findByRole('textbox')
  expect(field.getAttribute('contenteditable')).toBe('true')
  const editor = promptEditor(field)
  act(() => {
    editor.commands.selectAll()
  })
  let copied: string | undefined
  editor.view.someProp('clipboardTextSerializer', (serializer) => {
    copied = serializer(
      editor.state.doc.slice(editor.state.selection.from, editor.state.selection.to),
      editor.view
    )
    return true
  })
  expect(copied).toBe(text)
  expect(editor.state.doc.textBetween(0, editor.state.doc.content.size, '\n')).toBe(text)
  expect(readNativeChatComposerDraft(structuredAgentSessionDraftScopeKey('session-1')).text).toBe(
    text
  )
})
