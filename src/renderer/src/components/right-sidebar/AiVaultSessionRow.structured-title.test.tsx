// @vitest-environment happy-dom

import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionStatusEvent } from '../../../../shared/agent-session-wire'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import type { AiVaultSearchHit } from '../../../../shared/ai-vault-search-types'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { Tab } from '../../../../shared/tab-types'

const mocks = vi.hoisted(() => ({ subscribe: vi.fn(), supports: vi.fn() }))
vi.mock('@/runtime/structured-agent-session-client', () => ({
  subscribeStructuredAgentSessionStatus: mocks.subscribe
}))
vi.mock('@/runtime/runtime-rpc-client', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  runtimeEnvironmentSupportsCapability: mocks.supports
}))

import { TooltipProvider } from '@/components/ui/tooltip'
import { useAppStore } from '@/store'
import {
  getStructuredAgentSessionStatusFeed,
  resetStructuredAgentSessionStatusFeedsForTests
} from '@/runtime/structured-agent-session-status-feed'
import { VaultSessionRow } from './AiVaultSessionRow'
import { aiVaultSearchHitToSession } from './ai-vault-search-session'

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
    structuredSession: { workspaceId: 'folder-workspace', sessionId: 'native-session' }
  }
}

function searchRow(): AiVaultSession {
  const hit: AiVaultSearchHit = {
    agent: 'codex',
    sessionId: 'provider-session',
    title: 'Codex Chat',
    cwd: '/folder',
    branch: null,
    updatedAt: null,
    messageCount: 1,
    score: 1,
    source: { presence: 'present', filePath: '/sessions/provider-session.jsonl' },
    evidence: null,
    structuredSession: { workspaceId: 'folder-workspace', sessionId: 'native-session' }
  }
  return aiVaultSearchHitToSession(hit, 'local')
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
    useAppStore.setState({ unifiedTabsByWorktree: { 'folder-workspace': [tab()] } })
    await renderRow(row())
    expect(screen.getByText('Codex Chat')).toBeTruthy()
    publish('local', 'Explain the parser')
    expect(screen.getByText('Explain the parser')).toBeTruthy()
    act(() => useAppStore.setState({ unifiedTabsByWorktree: {} }))
    expect(screen.getByText('Explain the parser')).toBeTruthy()
    expect(screen.queryByText('Codex Chat')).toBeNull()
  })

  it.each([
    ['list', row],
    ['search', searchRow]
  ])(
    'lets a manual tab rename win in a %s row, and returns to the name once cleared',
    async (_kind, make) => {
      useAppStore.setState({ unifiedTabsByWorktree: { 'folder-workspace': [tab('Manual name')] } })
      await renderRow(make())
      publish('local', 'Explain the parser')
      expect(screen.getByText('Manual name')).toBeTruthy()
      act(() => useAppStore.setState({ unifiedTabsByWorktree: { 'folder-workspace': [tab()] } }))
      expect(screen.getByText('Explain the parser')).toBeTruthy()
    }
  )

  it('shows a search hit the name its host published', async () => {
    await renderRow(searchRow())
    publish('local', 'Explain the parser')
    expect(screen.getByText('Explain the parser')).toBeTruthy()
  })

  it.each(['constructor', '__proto__'])(
    'renders a paired row whose workspace id names an object member (%s)',
    async (workspaceId) => {
      await renderRow({
        ...row('local', 'Host row title'),
        structuredSession: { workspaceId, sessionId: 'native-session' }
      })
      expect(screen.getByText('Host row title')).toBeTruthy()
    }
  )

  it('ignores a published name no record store would hold', async () => {
    await renderRow(row('local', 'Host row title'))
    publish('local', 'x'.repeat(201))
    expect(screen.getByText('Host row title')).toBeTruthy()
  })

  it('keeps the host row title for a chat the feed has not named, as after a restart', async () => {
    await renderRow(row('local', 'Named before restart'))
    publish('local')
    expect(screen.getByText('Named before restart')).toBeTruthy()
  })

  it('never shows a name another host published for the same session id', async () => {
    mocks.supports.mockResolvedValue(true)
    const releaseLocal = getStructuredAgentSessionStatusFeed({ kind: 'local' }).activate()
    await renderRow(row('runtime:paired'))
    expect(emitters.has('local')).toBe(true)
    publish('local', 'Local chat name')
    publish('paired')
    expect(screen.getByText('Codex Chat')).toBeTruthy()
    expect(screen.queryByText('Local chat name')).toBeNull()
    releaseLocal()
  })

  it('keeps the host row title from an older paired host without probing it again', async () => {
    mocks.supports.mockResolvedValue(false)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await renderRow(row('runtime:older', 'Saved by older host'))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000)
    })
    expect(screen.getByText('Saved by older host')).toBeTruthy()
    expect(mocks.supports).toHaveBeenCalledTimes(1)
    expect(mocks.subscribe).not.toHaveBeenCalled()
  })
})
