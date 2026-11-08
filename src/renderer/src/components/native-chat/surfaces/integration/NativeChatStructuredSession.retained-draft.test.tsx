// @vitest-environment happy-dom

import type * as LaunchRegistry from '@/lib/agent-session/launch/structured-agent-session-launch-registry'
import type * as LaunchOptions from '@/lib/agent-session/launch/structured-agent-session-launch-options'
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { ManagedRuntimeInstallObservation } from '@/runtime/hosts/installation/use-managed-runtime-install'

const { mocks, moduleFactories, resetStructuredSessionMocks, launchModule } = await vi.hoisted(
  async () => {
    const setup = (
      await import('./NativeChatStructuredSession.test-harness')
    ).createStructuredSessionMocks()
    return {
      ...setup,
      launchModule: setup.moduleFactories.structuredAgentSessionLaunch()
    }
  }
)
const install = vi.hoisted((): { observation: ManagedRuntimeInstallObservation } => ({
  observation: { kind: 'inactive' }
}))

vi.mock('@/lib/agent-session/launch/structured-agent-session-launch', () => ({
  retryStructuredAgentSessionLaunch: launchModule.retryStructuredAgentSessionLaunch,
  relaunchFailedStructuredAgentSessionForMessage:
    launchModule.relaunchFailedStructuredAgentSessionForMessage
}))
vi.mock(
  '@/lib/agent-session/launch/structured-agent-session-launch-registry',
  async (importOriginal) => ({
    ...(await importOriginal<typeof LaunchRegistry>()),
    getStructuredAgentSessionLaunchLifecycle: launchModule.getStructuredAgentSessionLaunchLifecycle,
    getStructuredAgentSessionLaunchResumes: launchModule.getStructuredAgentSessionLaunchResumes,
    useStructuredAgentSessionLaunchLifecycle: launchModule.useStructuredAgentSessionLaunchLifecycle,
    useStructuredAgentSessionLaunchFailure: launchModule.useStructuredAgentSessionLaunchFailure
  })
)
vi.mock(
  '@/lib/agent-session/launch/structured-agent-session-launch-options',
  async (importOriginal) => ({
    ...(await importOriginal<typeof LaunchOptions>()),
    useStructuredAgentSessionLaunchSelection: launchModule.useStructuredAgentSessionLaunchSelection
  })
)
vi.mock('@/lib/agent-session/launch/structured-agent-session-launch-message', () =>
  moduleFactories.structuredAgentSessionLaunchMessage()
)
vi.mock('../../../../runtime/native-chat/requests/structured-agent-session-call', () =>
  moduleFactories.structuredAgentSessionCall()
)
vi.mock('../../../../runtime/native-chat/requests/structured-agent-session-subscriptions', () =>
  moduleFactories.structuredAgentSessionSubscriptions()
)
vi.mock('@/components/machine-identity/use-published-machine-name', () => ({
  usePublishedMachineName: () => null
}))
vi.mock('../../session/structured/use-structured-agent-session', () =>
  moduleFactories.useStructuredAgentSession()
)
vi.mock('../../appearance/use-native-chat-font-size', () => moduleFactories.useNativeChatFontSize())
vi.mock('../../links/actions/use-native-chat-file-link-context', () =>
  moduleFactories.useNativeChatFileLinkContext()
)
vi.mock('../../pane/ownership/use-native-chat-tab-owner', () =>
  moduleFactories.useNativeChatTabOwner()
)
vi.mock('../../links/actions/use-native-chat-file-link-click', () =>
  moduleFactories.useNativeChatFileLinkClick()
)
vi.mock('../../NativeChatMessageList', () => moduleFactories.nativeChatMessageList())
vi.mock('../../host-access/NativeChatEmptyState', () => moduleFactories.nativeChatEmptyState())
vi.mock('../../prompts/NativeChatApprovalCard', () => moduleFactories.nativeChatApprovalCard())
vi.mock('../../prompts/NativeChatQuestionCard', () => moduleFactories.nativeChatQuestionCard())
vi.mock('@/runtime/hosts/installation/use-managed-runtime-install', () => ({
  useManagedRuntimeInstall: () => install.observation
}))

import { NativeChatStructuredSession } from '../../NativeChatStructuredSession'
import { clearNativeChatComposerDraftsForTests } from '../../drafts/native-chat-draft-reset'
import { hydrateNativeChatComposerDrafts } from '../../drafts/native-chat-composer-draft-load'
import {
  readNativeChatComposerDraft,
  updateNativeChatComposerDraft
} from '../../drafts/native-chat-composer-draft-store'
import { structuredAgentSessionDraftScopeKey } from '../../drafts/native-chat-draft-scope'

import { TooltipProvider } from '@/components/ui/tooltip'
import { promptEditor } from '../../composer/editor/native-chat-prompt-editor.test-support'
import { promptTextContent } from '../../composer/editor/native-chat-prompt-document-text'
import {
  createMemoryNativeChatComposerDraftStorage,
  setNativeChatComposerDraftStorageForTests
} from '../../drafts/native-chat-composer-draft-storage'

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
