// @vitest-environment happy-dom

import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionStatusEvent } from '../../../../../../shared/agent-session/agent-session-wire'
import type { AiVaultSession } from '../../../../../../shared/ai-vault/contracts/ai-vault-types'

import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import type { Tab } from '../../../../../../shared/tab-types'

const mocks = vi.hoisted(() => ({ subscribe: vi.fn(), supports: vi.fn() }))
vi.mock('../../../../runtime/native-chat/requests/structured-agent-session-subscriptions', () => ({
  subscribeStructuredAgentSessionStatus: mocks.subscribe
}))
vi.mock('@/runtime/rpc/compatibility/runtime-capability-proof', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  runtimeEnvironmentSupportsCapability: mocks.supports
}))

import { TooltipProvider } from '@/components/ui/tooltip'
import { useAppStore } from '@/store/index'
import {
  getStructuredAgentSessionStatusFeed,
  resetStructuredAgentSessionStatusFeedsForTests
} from '@/runtime/native-chat/status/structured-agent-session-status-feed'
import { VaultSessionRow } from './AiVaultSessionRow'

const initialState = useAppStore.getInitialState()
const emitters = new Map<string, (event: AgentSessionStatusEvent) => void>()

function row(host: ExecutionHostId = 'local', title = 'Codex Chat'): AiVaultSession {
  return {
    id: `${host}:provider-session`,
    executionHostId: host,
    agent: 'codex',
    sessionId: 'provider-session',
    title,
    cwd: '/folder',
    branch: null,
    model: null,
    filePath: '/sessions/provider-session.jsonl',
    codexHome: null,
    createdAt: null,
    updatedAt: null,
    modifiedAt: '2026-10-06T00:00:00Z',
    messageCount: 1,
    totalTokens: 0,
    previewMessages: [],
    queuedMessageCount: 0,
    subagentTranscriptCount: 0,
    resumeCommand: 'codex resume provider-session',
    subagent: null,
    structuredSession: {
      workspaceId: 'folder-workspace',
      sessionId: 'native-session'
    }
  }
}

function tab(customLabel: string | null = null): Tab {
  return {
    id: 'native-tab',
    entityId: 'native-session',
    groupId: 'group',
    worktreeId: 'folder-workspace',
    executionHostId: 'local',
    contentType: 'agent-session',
    agentSessionAgent: 'codex',
    label: 'Codex Chat',
    customLabel,
    color: null,
    sortOrder: 0,
    createdAt: 1
  }
}

function publish(host: string, conversationName?: string): void {
  act(() =>
    emitters.get(host)?.({
      type: 'snapshot',
      sessions: [
        {
          sessionId: 'native-session',
          workspaceId: 'folder-workspace',
          agent: 'codex',
          status: 'idle',
          latestPrompt: 'Explain the parser',
          updatedAt: 1,
          ...(conversationName ? { conversationName } : {})
        }
      ]
    })
  )
}

async function renderRow(session: AiVaultSession): Promise<void> {
  render(
    <TooltipProvider>
      <VaultSessionRow
        session={session}
        liveState={null}
        resumeStartup={{ command: session.resumeCommand }}
        realHomeResumeStartup={{ command: session.resumeCommand }}
        worktreeInfo={null}
        vaultScope="all"
        detailsExpanded={false}
        resumeDisabled={false}
        onToggleDetails={vi.fn()}
        showJumpToWorktree={false}
        onResume={vi.fn()}
        resumeLabel="Resume"
        resumeActions={{
          worktree: { worktreeId: null, disabled: true },
          newTab: { worktreeId: null, disabled: true }
        }}
        onResumeInWorktree={vi.fn()}
        onResumeInNewTab={vi.fn()}
        onCopyId={vi.fn()}
        onCopyPath={vi.fn()}
      />
    </TooltipProvider>
  )
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0)
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  useAppStore.setState(initialState, true)
  resetStructuredAgentSessionStatusFeedsForTests()
  emitters.clear()
  mocks.supports.mockReset()
  mocks.subscribe.mockReset()
  mocks.subscribe.mockImplementation(
    (
      target: { kind: string; environmentId?: string },
      emit: (e: AgentSessionStatusEvent) => void
    ) => {
      emitters.set(target.environmentId ?? target.kind, emit)
      return Promise.resolve({ unsubscribe: vi.fn() })
    }
  )
})
afterEach(() => {
  cleanup()
  resetStructuredAgentSessionStatusFeedsForTests()
  useAppStore.setState(initialState, true)
  vi.useRealTimers()
})

describe('native chat names in Vault rows', () => {
  it('shows the name its host publishes with the tab open, and keeps it when the tab closes', async () => {
    useAppStore.setState({
      unifiedTabsByWorktree: { 'folder-workspace': [tab()] }
    })
    await renderRow(row())
    expect(screen.getByText('Codex Chat')).toBeTruthy()
    publish('local', 'Explain the parser')
    expect(screen.getByText('Explain the parser')).toBeTruthy()
    act(() => useAppStore.setState({ unifiedTabsByWorktree: {} }))
    expect(screen.getByText('Explain the parser')).toBeTruthy()
    expect(screen.queryByText('Codex Chat')).toBeNull()
  })

  it('never shows a name another host published for the same session id', async () => {
    mocks.supports.mockResolvedValue(true)
    const releaseLocal = getStructuredAgentSessionStatusFeed({
      kind: 'local'
    }).activate()
    await renderRow(row('runtime:paired'))
    expect(emitters.has('local')).toBe(true)
    publish('local', 'Local chat name')
    publish('paired')
    expect(screen.getByText('Codex Chat')).toBeTruthy()
    expect(screen.queryByText('Local chat name')).toBeNull()
    releaseLocal()
  })
})
