// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { cleanup, screen } from '@testing-library/react'
import { render } from '../../messages/actions/native-chat-tooltip-test-harness'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

// Why: these fixtures have neither inline visual owners nor sender navigation.
const unusedChatLeaves = vi.hoisted(() => ({
  inlineVisual: vi.fn(() => {
    throw new Error('Unexpected inline visual in transcript fixture')
  }),
  openSender: vi.fn(() => {
    throw new Error('Unexpected sender navigation in transcript fixture')
  })
}))
vi.mock('../../media/visuals/NativeChatInlineVisual', () => ({
  NativeChatInlineVisual: unusedChatLeaves.inlineVisual
}))
vi.mock('@/lib/open-agent-message-sender', () => ({
  openAgentMessageSender: unusedChatLeaves.openSender
}))
afterEach(() => {
  expect(unusedChatLeaves.inlineVisual).not.toHaveBeenCalled()
  expect(unusedChatLeaves.openSender).not.toHaveBeenCalled()
})
import { NativeChatOrcaStopContext } from '../../messages/notices/native-chat-orca-stop-context'
import { agentSessionFailureWords } from '../../../../../../shared/agent-session/failures/agent-session-failure-words'
import type {
  AgentJournalItemBody,
  AgentJournalRenderItem
} from '../../../../../../shared/agent-session/journal/agent-session-journal-types'

import { selectStructuredAgentSettledTurns } from '../../../../../../shared/agent-session/view/structured-agent-session-turn-timing'

import { NativeChatMessageList } from '../../NativeChatMessageList'
import { installNativeChatMessageListTestViewport } from '../../viewport/virtualization/native-chat-message-list-test-viewport'
import { projectStructuredAgentSessionMessages } from '../projection/structured-agent-session-message-projection'
import {
  agentJournalItemKey,
  agentJournalSubmissionKey
} from '../../../../../../shared/agent-session/journal/agent-session-journal-item-key'
import { latestNativeChatOrcaStopCut } from '../../../../../../shared/native-chat/native-chat-orca-stop-cut'
import { latestNativeChatUsageLimitCut } from '../../../../../../shared/native-chat/native-chat-usage-limit-cut'
import { latestStructuredAgentSessionRequest } from '../../../../../../shared/agent-session/requests/structured-agent-session-latest-request'

let restoreViewport = (): void => {}
beforeAll(() => {
  restoreViewport = installNativeChatMessageListTestViewport()
})
afterAll(() => restoreViewport())
afterEach(cleanup)

const continueUsageLimit = vi.fn()
const usageLimitView = {
  hostLabel: null,
  remoteHost: false,
  continueAvailable: false,
  offeredTurnItemId: null,
  continueNow: vi.fn(),
  usageLimitTurnItemId: 'item-2',
  continueUsageLimit
}
// A host that could continue, with no turn the selectors offered.
const commandView = {
  ...usageLimitView,
  continueAvailable: true,
  offeredTurnItemId: null,
  usageLimitTurnItemId: null
}

{
  function retry(sequence: number, attempt: number): AgentJournalRenderItem {
    return {
      itemId: `retry-${sequence}`,
      revision: 1,
      sequence,
      observedAt: sequence,
      body: {
        kind: 'status',
        tone: 'warning',
        ...agentSessionFailureWords(
          {
            kind: 'providerRetrying',
            detail: { text: `Reconnecting... ${attempt}/5`, audience: 'person' },
            retry: { cause: 'stream disconnected before completion' }
          },
          { surface: 'row', agentName: 'Codex' }
        )
      }
    }
  }

  function transcript(items: AgentJournalRenderItem[]) {
    return (
      <NativeChatMessageList
        session={{
          messages: projectStructuredAgentSessionMessages(items, [], []),
          status: 'ready',
          sessionId: 'live-codex',
          agent: 'codex',
          hasMore: false,
          loadingEarlier: false,
          olderHistoryGeneration: 0,
          loadEarlier: vi.fn(),
          readPhase: 'ready'
        }}
        isWorking={false}
        expandSignal
      />
    )
  }

  describe('a Codex retrying a dropped stream', () => {
    it('draws one warning for the run, with what failed on its second line', () => {
      render(transcript([retry(1, 1), retry(2, 2), retry(3, 3)]))

      const rows = screen.getAllByText(/Codex is retrying/)
      expect(rows).toHaveLength(1)
      expect(rows[0]?.textContent).toBe(
        'Codex is retrying: Reconnecting... 3/5.\nstream disconnected before completion'
      )
    })
  })
}

{
  const compactEntry = agentJournalSubmissionKey('cmd-1')
  const commandTurn = agentJournalItemKey({
    provider: 'orca',
    clientMessageId: 'command-turn:cmd-1'
  })
  const row = (
    itemId: string,
    sequence: number,
    body: AgentJournalItemBody,
    turnItemId?: string
  ): AgentJournalRenderItem => ({
    itemId,
    revision: 1,
    sequence,
    observedAt: sequence,
    body,
    turnScope: turnItemId ? { kind: 'turn', turnItemId } : { kind: 'thread' }
  })
  const settled = (
    itemId: string,
    userItemId: string,
    outcome: 'success' | 'failure',
    at: number
  ) =>
    row(itemId, at, {
      kind: 'turn',
      turnId: itemId,
      userItemId,
      state: 'completed',
      outcome,
      startedAt: at * 1000,
      completedAt: at * 1000 + 4000
    })
  const failures: [string, AgentJournalItemBody, RegExp][] = [
    [
      'usage-limit warning',
      {
        kind: 'status',
        tone: 'warning',
        ...agentSessionFailureWords(
          {
            kind: 'usageLimitReached',
            usageLimit: { window: 'session', resetsAt: 1_700_000_000_000 },
            detail: { text: "You've hit your limit", audience: 'person' }
          },
          { surface: 'row', agentName: 'Claude' }
        )
      },
      /hit its session limit/
    ],
    [
      'compaction failure',
      {
        kind: 'status',
        tone: 'error',
        ...agentSessionFailureWords(
          { kind: 'compactionFailed', detail: { text: 'nothing to compact', audience: 'person' } },
          { surface: 'row', agentName: 'Grok' }
        )
      },
      /Compaction failed: nothing to compact/
    ],
    [
      'fact-less provider error',
      { kind: 'status', tone: 'error', text: 'API Error: 529 upstream overloaded' },
      /API Error: 529 upstream overloaded/
    ]
  ]

  describe('a failed /compact command turn', () => {
    it.each(failures)(
      'shows its %s with no recovery controls, leaving the request before it as it was',
      (_name, failure, words) => {
        const items = [
          row('u1', 1, {
            kind: 'message',
            role: 'user',
            blocks: [{ type: 'text', text: 'Fix it' }]
          }),
          settled('t1', 'u1', 'success', 2),
          row(
            't1-answer',
            3,
            { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'Fixed.' }] },
            't1'
          ),
          row(compactEntry, 10, {
            kind: 'message',
            role: 'user',
            blocks: [{ type: 'text', text: '/compact' }],
            command: { name: 'compact' }
          }),
          settled(commandTurn, compactEntry, 'failure', 11),
          row('command-failure', 12, failure, commandTurn)
        ]
        // The live list's Continue targets come from these selectors; neither offers the command.
        expect(latestNativeChatOrcaStopCut(items, [])).toBeNull()
        expect(latestNativeChatUsageLimitCut(items, [])).toBeNull()
        render(
          <NativeChatOrcaStopContext.Provider value={commandView}>
            <NativeChatMessageList
              session={{
                messages: projectStructuredAgentSessionMessages(items, [], []),
                status: 'ready',
                sessionId: 'session-1',
                agent: 'claude',
                hasMore: false,
                loadingEarlier: false,
                olderHistoryGeneration: 0,
                loadEarlier: vi.fn(),
                readPhase: 'ready'
              }}
              journalItems={items}
              settledTurns={selectStructuredAgentSettledTurns(items)}
              isWorking={false}
              expandSignal={false}
            />
          </NativeChatOrcaStopContext.Provider>
        )
        expect(screen.getByText('/compact')).toBeVisible()
        expect(screen.getAllByText(words)).toHaveLength(1)
        expect(screen.getByText(words)).toBeVisible()
        expect(screen.queryByRole('button', { name: /Continue/ })).toBeNull()
        expect(screen.queryByRole('separator', { name: 'Context compacted' })).toBeNull()
        expect(screen.getByText('Fixed.')).toBeVisible()
        // Status readers keep the last real request's verdict through the failed command.
        expect(latestStructuredAgentSessionRequest(items, [])).toMatchObject({
          id: 't1',
          outcome: 'success'
        })
      }
    )
  })
}
