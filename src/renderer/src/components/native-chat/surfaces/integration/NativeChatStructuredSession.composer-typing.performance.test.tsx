// @vitest-environment happy-dom

import type * as LaunchRegistry from '@/lib/agent-session/launch/structured-agent-session-launch-registry'
import type * as LaunchOptions from '@/lib/agent-session/launch/structured-agent-session-launch-options'
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentJournalRenderItem } from '../../../../../../shared/agent-session/journal/agent-session-journal-types'

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
  useManagedRuntimeInstall: () => ({ kind: 'inactive' })
}))

import { NativeChatStructuredSession } from '../../NativeChatStructuredSession'
import { clearNativeChatComposerDraftsForTests } from '../../drafts/native-chat-draft-reset'
import { hydrateNativeChatComposerDrafts } from '../../drafts/native-chat-composer-draft-load'
import { updateNativeChatComposerDraft } from '../../drafts/native-chat-composer-draft-store'
import { structuredAgentSessionDraftScopeKey } from '../../drafts/native-chat-draft-scope'
import { TooltipProvider } from '@/components/ui/tooltip'
import { promptTextContent } from '../../composer/editor/native-chat-prompt-document-text'
import {
  createMemoryNativeChatComposerDraftStorage,
  setNativeChatComposerDraftStorageForTests
} from '../../drafts/native-chat-composer-draft-storage'
import { useAppStore } from '@/store'

afterEach(() => {
  cleanup()
  resetStructuredSessionMocks()
  clearNativeChatComposerDraftsForTests()
})

function journalMessage(index: number): AgentJournalRenderItem {
  return {
    itemId: `message-${index}`,
    revision: 1,
    sequence: index + 1,
    observedAt: index + 1,
    body: {
      kind: 'message',
      role: index % 2 === 0 ? 'user' : 'assistant',
      blocks: [{ type: 'text', text: `Message ${index}` }]
    }
  }
}

function session(): React.JSX.Element {
  return (
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
}

describe('structured session composer typing', () => {
  it.each([50, 500])(
    'renders no transcript while typing beside %i journal items',
    async (count) => {
      clearNativeChatComposerDraftsForTests()
      setNativeChatComposerDraftStorageForTests(createMemoryNativeChatComposerDraftStorage())
      await hydrateNativeChatComposerDrafts()
      mocks.journalItems = Array.from({ length: count }, (_, index) => journalMessage(index))
      mocks.messages = mocks.journalItems.map((item) => ({
        id: item.itemId,
        role: 'assistant',
        source: 'transcript',
        timestamp: item.observedAt,
        blocks: [{ type: 'text', text: item.itemId }]
      }))
      const { rerender } = render(session())
      await screen.findByRole('textbox')
      const scopeKey = structuredAgentSessionDraftScopeKey('session-1')
      let storePublications = 0
      const unsubscribe = useAppStore.subscribe(() => {
        storePublications += 1
      })
      const rendersBefore = mocks.messageListRenders
      expect(rendersBefore).toBeGreaterThan(0)
      let text = ''
      for (let keystroke = 0; keystroke < 20; keystroke += 1) {
        text += 'a'
        act(() => {
          updateNativeChatComposerDraft(
            scopeKey,
            { text, document: promptTextContent(text) },
            'deferred'
          )
        })
      }
      unsubscribe()
      // The draft lives in its own scope store; only the composer is its subscriber.
      expect(mocks.messageListRenders - rendersBefore).toBe(0)
      expect(storePublications).toBe(0)

      mocks.journalItems = [...mocks.journalItems, journalMessage(count)]
      rerender(session())
      expect(mocks.messageListRenders - rendersBefore).toBeGreaterThan(0)
    }
  )
})
