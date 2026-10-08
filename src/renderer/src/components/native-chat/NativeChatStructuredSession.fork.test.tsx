// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { useContext } from 'react'
import { afterEach, expect, it, vi } from 'vitest'

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
vi.mock('./use-native-chat-tab-owner', () => moduleFactories.useNativeChatTabOwner())
vi.mock('./NativeChatComposer', () => moduleFactories.nativeChatComposer())
vi.mock('./NativeChatApprovalCard', () => moduleFactories.nativeChatApprovalCard())
vi.mock('./NativeChatQuestionCard', () => moduleFactories.nativeChatQuestionCard())
vi.mock('@/runtime/structured-agent-session-host-capability', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useStructuredAgentSessionHostCapability: () => true
}))
// Stand-ins that show only what the pane hands them: the rows offered a fork, and the lineage line.
vi.mock('./NativeChatMessageList', async () => {
  const { NativeChatForkContext } = await import('./native-chat-fork-context')
  return {
    NativeChatMessageList: () => (
      <div data-testid="fork-rows">
        {[...(useContext(NativeChatForkContext)?.rows ?? [])].join()}
      </div>
    )
  }
})
vi.mock('./NativeChatForkedFromLine', () => ({
  NativeChatForkedFromLine: (props: { sessionId: string; worktreeId: string | null }) => (
    <div data-testid="forked-from">{`${props.sessionId}@${props.worktreeId}`}</div>
  )
}))

import type { AgentJournalRenderItem } from '../../../../shared/agent-session-journal-types'
import { NativeChatStructuredSession } from './NativeChatStructuredSession'

afterEach(() => {
  cleanup()
  resetStructuredSessionMocks()
})

function row(itemId: string, body: unknown, turnItemId?: string) {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fork rows are chosen from a row's id, body and turn scope alone.
  return {
    itemId,
    body,
    ...(turnItemId ? { turnScope: { kind: 'turn', turnItemId } } : {})
  } as AgentJournalRenderItem
}

it('offers its transcript the fork of each finished turn, and draws where the chat was forked from', () => {
  mocks.journalItems = [
    row('turn-a', { kind: 'turn', turnId: 'a', state: 'completed', outcome: 'success' }),
    row(
      'a-answer',
      { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'done' }] },
      'turn-a'
    )
  ]

  render(
    <NativeChatStructuredSession
      isVisible
      isFocusedGroup
      tabId="structured-fork-tab"
      sessionId="codex_parent"
      target={{ kind: 'local' }}
      agent="codex"
    />
  )

  expect(screen.getByTestId('fork-rows')).toHaveTextContent('a-answer')
  expect(screen.getByTestId('forked-from')).toHaveTextContent('codex_parent@wt-1')
})
