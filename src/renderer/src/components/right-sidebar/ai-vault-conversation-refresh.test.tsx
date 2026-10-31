import { AgentSessionAssociationObservation } from '../../../../shared/agent-session-status-snapshot-fold'
// @vitest-environment happy-dom

import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentSessionStatusSummary } from '../../../../shared/agent-session-wire'
import type {
  AiVaultListArgs,
  AiVaultListResult,
  AiVaultSession
} from '../../../../shared/ai-vault-types'
import type { ExecutionHostScope } from '../../../../shared/execution-host'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { useAppStore } from '@/store'
import {
  resetAiVaultForcedRescanThrottleForTest,
  useAiVaultSessionRefresh
} from './ai-vault-session-refresh'

const feeds = vi.hoisted(
  () =>
    new Map<
      string,
      {
        snapshot: ReadonlyMap<string, AgentSessionStatusSummary>
        associations: AgentSessionAssociationObservation
        listeners: Set<() => void>
        activate: ReturnType<typeof vi.fn>
      }
    >()
)

vi.mock('@/runtime/structured-agent-session-status-feed', () => ({
  getStructuredAgentSessionStatusFeed: (target: RuntimeClientTarget) => {
    const key = target.kind === 'local' ? 'local' : `runtime:${target.environmentId}`
    let feed = feeds.get(key)
    if (!feed) {
      feed = {
        snapshot: new Map(),
        associations: new AgentSessionAssociationObservation(),
        listeners: new Set(),
        activate: vi.fn(() => () => {})
      }
      feeds.set(key, feed)
    }
    const owner = feed
    return {
      activate: owner.activate,
      getSnapshot: () => owner.snapshot,
      getAssociationRevision: () => owner.associations.revision,
      subscribe: (listener: () => void) => {
        owner.listeners.add(listener)
        return () => owner.listeners.delete(listener)
      }
    }
  }
}))

const initialState = useAppStore.getInitialState()
const list = vi.fn<(args?: AiVaultListArgs) => Promise<AiVaultListResult>>()
let latest: ReturnType<typeof useAiVaultSessionRefresh> | undefined
let response: AiVaultListResult

function Probe({ scope = 'local' }: { scope?: ExecutionHostScope }): null {
  latest = useAiVaultSessionRefresh([], scope, 500, true)
  return null
}

function saved(
  title: string,
  executionHostId: AiVaultSession['executionHostId'] = 'local'
): AiVaultSession {
  return {
    source: 'structured-record',
    id: `${executionHostId}:chat`,
    executionHostId,
    agent: 'gemini',
    sessionId: 'saved-chat',
    title,
    cwd: '/notes',
    branch: null,
    model: null,
    filePath: '',
    codexHome: null,
    createdAt: '2026-10-25T00:00:00Z',
    updatedAt: '2026-10-25T00:00:00Z',
    modifiedAt: '2026-10-25T00:00:00Z',
    messageCount: 0,
    totalTokens: 0,
    previewMessages: [],
    queuedMessageCount: 0,
    subagentTranscriptCount: 0,
    resumeCommand: '',
    subagent: null,
    structuredSession: { sessionId: 'saved-chat', workspaceId: 'folder:notes' }
  }
}

async function publish(
  host: string,
  overrides: Partial<AgentSessionStatusSummary> = {}
): Promise<void> {
  await act(async () => {
    const feed = feeds.get(host)
    if (!feed) {
      throw new Error(`No subscription for ${host}`)
    }
    const summary: AgentSessionStatusSummary = {
      sessionId: 'saved-chat',
      workspaceId: 'folder:notes',
      agent: 'gemini',
      status: null,
      latestPrompt: '',
      updatedAt: 1,
      ...overrides
    }
    feed.snapshot = new Map([[summary.sessionId, summary]])
    feed.associations.observe({ type: 'status', session: summary })
    for (const listener of feed.listeners) {
      listener()
    }
  })
}

beforeEach(() => {
  feeds.clear()
  latest = undefined
  resetAiVaultForcedRescanThrottleForTest()
  useAppStore.setState(initialState, true)
  response = {
    sessions: [],
    issues: [],
    scannedAt: '2026-10-25T00:00:00Z',
    fingerprint: 'a'.repeat(64)
  }
  list.mockReset().mockImplementation(async () => response)
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      aiVault: {
        listSessions: list,
        cancelListSessions: vi.fn(async () => {}),
        onWindowFocused: () => () => {}
      }
    }
  })
})

afterEach(() => {
  cleanup()
  useAppStore.setState(initialState, true)
})

it('publishes creation and rename without provider IDs, tab state, or a forced disk scan', async () => {
  render(<Probe />)
  await act(async () => {})
  expect(latest?.sessions).toEqual([])
  response = { ...response, sessions: [saved('New Gemini chat')], fingerprint: 'b'.repeat(64) }
  await publish('local')
  expect(latest?.sessions[0]?.title).toBe('New Gemini chat')
  response = {
    ...response,
    sessions: [saved('Renamed retained chat')],
    fingerprint: 'c'.repeat(64)
  }
  await publish('local', { conversationName: 'Renamed retained chat' })
  expect(latest?.sessions[0]?.title).toBe('Renamed retained chat')
  expect(latest?.scanResult?.scannedAt).toBe('2026-10-25T00:00:00Z')
  expect(
    list.mock.calls.every(
      ([args]) => args?.includeStructuredSessions === true && args.force !== true
    )
  ).toBe(true)
  await act(async () => useAppStore.setState({ unifiedTabsByWorktree: {} }))
  expect(latest?.sessions).toHaveLength(1)
  const beforeNativeProvider = list.mock.calls.length
  await act(async () =>
    useAppStore.setState({
      agentStatusByPaneKey: {
        native: {
          state: 'working',
          agentType: 'gemini',
          prompt: '',
          updatedAt: 1,
          stateStartedAt: 1,
          paneKey: 'native',
          stateHistory: [],
          providerSession: { key: 'session_id', id: 'native-provider' },
          terminalResumeEligible: false
        }
      }
    })
  )
  expect(list).toHaveBeenCalledTimes(beforeNativeProvider)
  await act(async () =>
    useAppStore.setState({
      agentStatusByPaneKey: {
        terminal: {
          state: 'working',
          agentType: 'claude',
          prompt: '',
          updatedAt: 1,
          stateStartedAt: 1,
          paneKey: 'terminal',
          stateHistory: [],
          providerSession: { key: 'session_id', id: 'terminal-provider' }
        }
      }
    })
  )
  expect(list.mock.calls.at(-1)?.[0]?.force).toBe(true)
})

it('uses only the selected remote status feed and keeps live activity from causing disk rescans', async () => {
  render(<Probe scope="runtime:remote" />)
  await act(async () => {})
  expect([...feeds.keys()]).toEqual(['runtime:remote'])
  response = {
    ...response,
    sessions: [saved('Remote retained chat', 'runtime:remote')],
    fingerprint: 'b'.repeat(64)
  }
  await publish('runtime:remote', { status: 'working', updatedAt: 10 })
  expect(latest?.sessions[0]?.executionHostId).toBe('runtime:remote')
  const calls = list.mock.calls.length
  await publish('runtime:remote', {
    status: 'working',
    updatedAt: 11,
    latestPrompt: 'agent progress'
  })
  await publish('runtime:remote', { status: 'working', updatedAt: 12, toolName: 'Read' })
  expect(list).toHaveBeenCalledTimes(calls)
})

it('withholds previous-host chats while a newly selected remote host is still answering', async () => {
  response = { ...response, sessions: [saved('Local only')] }
  const view = render(<Probe />)
  await act(async () => {})
  expect(latest?.sessions[0]?.title).toBe('Local only')
  let answer: ((value: AiVaultListResult) => void) | undefined
  list.mockImplementation(
    async () =>
      new Promise((resolve) => {
        answer = resolve
      })
  )
  view.rerender(<Probe scope="runtime:remote" />)
  await act(async () => {})
  expect(latest?.sessions).toEqual([])
  expect(feeds.get('local')?.listeners.size).toBe(0)
  await act(async () =>
    answer?.({
      ...response,
      sessions: [saved('Remote only', 'runtime:remote')],
      fingerprint: 'b'.repeat(64)
    })
  )
  expect(latest?.sessions.map((row) => row.title)).toEqual(['Remote only'])
})
