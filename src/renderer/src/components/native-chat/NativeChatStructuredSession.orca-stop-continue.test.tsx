// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { useImperativeHandle } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import type * as HostCapabilityModule from '@/runtime/structured-agent-session-host-capability'

const { mocks, moduleFactories, resetStructuredSessionMocks } = await vi.hoisted(async () =>
  (await import('./NativeChatStructuredSession.test-harness')).createStructuredSessionMocks()
)

vi.mock('@/lib/structured-agent-session-launch', () =>
  moduleFactories.structuredAgentSessionLaunch()
)
vi.mock('@/runtime/structured-agent-session-client', () =>
  moduleFactories.structuredAgentSessionClient()
)
vi.mock('./use-structured-agent-session', () => moduleFactories.useStructuredAgentSession())
vi.mock('./use-native-chat-font-size', () => moduleFactories.useNativeChatFontSize())
vi.mock('./use-native-chat-file-link-context', () => moduleFactories.useNativeChatFileLinkContext())
vi.mock('./use-native-chat-file-link-click', () => moduleFactories.useNativeChatFileLinkClick())
vi.mock('./NativeChatComposer', () => moduleFactories.nativeChatComposer())
vi.mock('./NativeChatApprovalCard', () => moduleFactories.nativeChatApprovalCard())
vi.mock('./NativeChatQuestionCard', () => moduleFactories.nativeChatQuestionCard())
vi.mock('@/runtime/structured-agent-session-host-capability', async (importOriginal) => {
  const original = await importOriginal<typeof HostCapabilityModule>()
  const { AGENT_SESSION_CONTINUE_INTERRUPTED_RUNTIME_CAPABILITY } =
    await import('../../../../shared/agent-session-continue-interrupted-capability')
  return {
    ...original,
    useStructuredAgentSessionHostCapabilityState: (
      ...args: Parameters<typeof original.useStructuredAgentSessionHostCapabilityState>
    ) =>
      args[1] === AGENT_SESSION_CONTINUE_INTERRUPTED_RUNTIME_CAPABILITY
        ? 'supported'
        : original.useStructuredAgentSessionHostCapabilityState(...args)
  }
})
// The transcript's real rows, projected from the journal; only the list's windowing is left out.
vi.mock('./NativeChatMessageList', async () => {
  const { MessageRow } = await import('./NativeChatMessageRow')
  const { projectStructuredItemsToNativeChat } =
    await import('../../../../shared/structured-agent-session-projection')
  return {
    NativeChatMessageList: (props: {
      ref?: React.Ref<unknown>
      journalItems?: Parameters<typeof projectStructuredItemsToNativeChat>[0]
    }) => {
      useImperativeHandle(props.ref, () => ({ revealLatest: () => {}, revealFindMatch: () => {} }))
      return (
        <div data-testid="transcript">
          {projectStructuredItemsToNativeChat(props.journalItems ?? []).map((message) => (
            <MessageRow
              key={message.id}
              message={message}
              expandSignal={false}
              onScrollMessageToTop={() => {}}
            />
          ))}
        </div>
      )
    }
  }
})

import { TooltipProvider } from '@/components/ui/tooltip'
import { NativeChatStructuredSession } from './NativeChatStructuredSession'
import { agentJournalItemKey } from '../../../../shared/agent-session-journal-item-key'
import type { AgentJournalRenderItem } from '../../../../shared/agent-session-journal-types'

const TURN = agentJournalItemKey({ provider: 'codex', threadId: 't', turnId: 'cut', ordinal: 1 })

const cutChat: AgentJournalRenderItem[] = [
  {
    itemId: TURN,
    revision: 2,
    sequence: 1,
    observedAt: 1,
    body: { kind: 'turn', turnId: 'cut', state: 'interrupted', startedAt: 1, completedAt: 5 }
  },
  {
    itemId: agentJournalItemKey({ provider: 'orca', clientMessageId: 'stale-session:s:death-1-5' }),
    revision: 1,
    sequence: 2,
    observedAt: 6,
    turnScope: { kind: 'turn', turnItemId: TURN },
    body: {
      kind: 'status',
      text: 'Codex stopped while this response was in progress. You can continue in this conversation.',
      tone: 'error',
      presentation: 'orca-stop',
      orcaStop: { cause: 'crash' }
    }
  }
]

afterEach(() => {
  cleanup()
  resetStructuredSessionMocks()
})

it('offers one Continue, in the card that says Orca stopped, and the card does not say it again', () => {
  mocks.journalItems = cutChat
  render(
    <TooltipProvider>
      <NativeChatStructuredSession
        isVisible
        isFocusedGroup
        tabId="orca-stop-tab"
        sessionId="orca-stop-session"
        // A paired server with no name to show.
        target={{ kind: 'environment', environmentId: 'env-unnamed' }}
        agent="codex"
      />
    </TooltipProvider>
  )

  // Throws on a second Continue anywhere in the pane, such as the old row above the composer.
  const button = screen.getByRole('button', { name: 'Continue' })
  const sentence = screen.getByText(
    'Orca on the remote server stopped unexpectedly while this response was in progress.'
  )
  expect(sentence.parentElement).toContainElement(button)
  expect(screen.getByTestId('transcript')).toContainElement(button)
  expect(screen.queryByText(/You can continue in this conversation/)).toBeNull()
})
