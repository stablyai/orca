import { aiVaultSessionFixture } from '../../../../shared/ai-vault-session.test-fixture'
// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { stubLayout, stubResizeObserver } from '../native-chat/native-chat-windowing-test-harness'

import { EMPTY_AGENT_SESSION_CONTEXT } from '../../../../shared/agent-session-context'
import type { AgentSubagentSourceData } from './AgentSubagentContext'
import { AgentSubagentSheet } from './AgentSubagentSheet'

const mocks = vi.hoisted(() => ({ list: vi.fn(), transcript: vi.fn() }))
vi.mock('./use-agent-subagent-sessions', () => ({ useAgentSubagentSessions: mocks.list }))
vi.mock('../native-chat/use-native-chat-live-session', () => ({
  useNativeChatLiveSession: mocks.transcript
}))
afterEach(cleanup)
beforeEach(() => {
  const restoreLayout = stubLayout()
  const restoreObserver = stubResizeObserver()
  return () => {
    restoreObserver()
    restoreLayout()
  }
})

it.each(['grok', 'omp'] as const)(
  'keeps %s nested child status fresh and child answers in the selected transcript',
  (agent) => {
    const child = aiVaultSessionFixture({
      id: 'child',
      sessionId: 'child',
      title: 'Child',
      filePath: '/host/child.jsonl',
      agent,
      createdAt: '2026-09-07T00:00:00Z',
      modifiedAt: '2026-09-07T00:00:01Z',
      subagent: { parentSessionId: 'parent', agentType: null, status: 'running' }
    })
    const grandchild = {
      ...child,
      id: 'grandchild',
      sessionId: 'grandchild',
      title: 'Grandchild',
      filePath: '/host/grandchild.jsonl'
    }
    let done = false
    mocks.list.mockImplementation(({ parentFilePath }) => ({
      loading: false,
      sessions:
        parentFilePath === child.filePath
          ? [{ ...grandchild, subagent: { status: done ? 'completed' : 'running' } }]
          : []
    }))
    mocks.transcript.mockImplementation(({ sessionId }) => ({
      agent,
      sessionId,
      status: 'ready',
      context: EMPTY_AGENT_SESSION_CONTEXT,
      hasMore: false,
      loadingEarlier: false,
      loadEarlier: vi.fn(),
      markCompactionRequested: vi.fn(),
      readPhase: 'ready',
      messages: [
        {
          id: 'task',
          role: 'user',
          source: 'transcript',
          timestamp: 0,
          blocks: [{ type: 'text', text: 'Report your status' }]
        },
        {
          id: 'answer',
          role: 'assistant',
          source: 'transcript',
          timestamp: 1,
          blocks: [{ type: 'text', text: `${sessionId} answer` }]
        }
      ]
    }))
    const sourceData: AgentSubagentSourceData = {
      loading: false,
      sessions: [child],
      source: {
        key: 'parent',
        identity: agent,
        agent,
        showIdentity: false,
        sessionId: 'parent',
        transcriptPath: '/host/parent.jsonl',
        target: { kind: 'environment', environmentId: 'remote' },
        runtimeEnvironmentId: 'remote',
        liveSubagents: []
      }
    }
    const props = {
      open: true,
      data: [sourceData],
      initialSelection: { sourceData, session: child },
      onOpenChange: vi.fn()
    }
    const view = render(<AgentSubagentSheet {...props} />)
    expect(screen.getByText('child answer')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Grandchild' }))
    expect(screen.queryByText('child answer')).toBeNull()
    expect(screen.getByText('grandchild answer')).toBeTruthy()
    expect(screen.getByText('Active')).toBeTruthy()
    done = true
    view.rerender(<AgentSubagentSheet {...props} />)
    expect(screen.getByText('Done')).toBeTruthy()
    expect(mocks.list).toHaveBeenCalledWith(
      expect.objectContaining({ parentFilePath: child.filePath, target: sourceData.source.target })
    )
    expect(mocks.transcript).toHaveBeenLastCalledWith(
      expect.objectContaining({
        transcriptPath: grandchild.filePath,
        runtimeEnvironmentId: 'remote'
      })
    )
  }
)
