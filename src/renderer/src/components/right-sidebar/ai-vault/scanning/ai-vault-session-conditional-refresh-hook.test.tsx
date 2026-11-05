// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AiVaultListResult,
  AiVaultSession
} from '../../../../../../shared/ai-vault/contracts/ai-vault-types'
import type { ExecutionHostScope } from '../../../../../../shared/execution-host'
import { useAppStore } from '@/store/index'
import { filterAiVaultSessions } from '../../../../../../shared/ai-vault/session-display/ai-vault-session-filters'
import { AiVaultSessionVirtualList } from '../session-list/AiVaultSessionVirtualList'
import {
  markInputQuietSchedulerInput,
  resetInputQuietSchedulerForTest
} from '@/lib/input-quiet-scheduler'
import {
  resetAiVaultForcedRescanThrottleForTest,
  useAiVaultSessionRefresh
} from './ai-vault-session-refresh'

import type { AgentSessionStatusEvent } from '../../../../../../shared/agent-session/agent-session-wire'
import { resetStructuredAgentSessionStatusFeedsForTests } from '@/runtime/structured-agent-session-status-feed'
const statusFrames = vi.hoisted(() => ({ emit: (_event: AgentSessionStatusEvent): void => {} }))
vi.mock('@/runtime/structured-agent-session-client', () => ({
  subscribeStructuredAgentSessionStatus: async (
    _target: unknown,
    emit: typeof statusFrames.emit
  ) => {
    statusFrames.emit = emit
    return { unsubscribe: () => {} }
  }
}))
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({ index, key: index, start: index * 40 })),
    getTotalSize: () => count * 40,
    measureElement: vi.fn(),
    scrollOffset: 0
  })
}))
vi.mock('../session-list/AiVaultVirtualRow', () => ({
  AiVaultVirtualRow: ({
    row,
    onResume
  }: {
    row: { type: string; session?: AiVaultSession }
    onResume: (session: AiVaultSession, worktreeId: string) => void
  }) =>
    row.session ? (
      <button onClick={() => row.session && onResume(row.session, 'workspace')}>
        {row.session.title}
      </button>
    ) : null
}))

const session: AiVaultSession = {
  id: 'runtime:one:codex:session:/session.jsonl',
  executionHostId: 'runtime:one',
  agent: 'codex',
  sessionId: 'session',
  title: 'Original title',
  cwd: '/repo',
  branch: null,
  model: null,
  filePath: '/session.jsonl',
  codexHome: null,
  createdAt: null,
  updatedAt: null,
  modifiedAt: 'date',
  messageCount: 1,
  totalTokens: 42,
  previewMessages: [{ role: 'user', text: 'Prompt', timestamp: null }],
  queuedMessageCount: 0,
  subagentTranscriptCount: 0,
  resumeCommand: 'codex resume session',
  subagent: null
}
const first: AiVaultListResult = {
  sessions: [session],
  issues: [],
  scannedAt: 'same',
  fingerprint: 'a'.repeat(64)
}
const list = vi.fn<(args: unknown) => Promise<AiVaultListResult>>()
const initialState = useAppStore.getInitialState()
let root: Root | null = null
let latest: ReturnType<typeof useAiVaultSessionRefresh> | null = null
const pendingRenders: boolean[] = []
const resume = vi.fn()
const unused = (): never => {
  throw new Error('Unexpected row callback')
}

function Probe({
  host,
  limit,
  paths,
  showList = false,
  noAgentsSelected = false
}: {
  host: ExecutionHostScope
  limit: number
  paths: readonly string[]
  showList?: boolean
  noAgentsSelected?: boolean
}): React.JSX.Element | null {
  latest = useAiVaultSessionRefresh(paths, host, limit)
  if (!showList) {
    return null
  }
  pendingRenders.push(latest.scopePending)
  const sessions = filterAiVaultSessions(latest.sessions, {
    query: '',
    agents: noAgentsSelected ? [] : ['codex'],
    scope: 'workspace',
    sort: 'updated',
    activeWorktreePaths: paths,
    hideEmptySessions: true
  })
  return (
    <AiVaultSessionVirtualList
      groups={[{ key: 'rows', label: null, sessions }]}
      collapsedGroups={new Set()}
      loading={latest.loading}
      scopePending={latest.scopePending}
      sessionsCount={latest.sessions.length}
      filteredSessionsCount={sessions.length}
      noAgentsSelected={noAgentsSelected}
      error={latest.error}
      vaultScope="workspace"
      buildResumeStartup={unused}
      getOriginalPaneTarget={unused}
      isStructuredSessionOpen={unused}
      getSessionLiveState={unused}
      getWorktreeInfo={unused}
      getSessionResumeState={unused}
      getSessionResumeActions={unused}
      getSessionResumeInChat={unused}
      onToggleGroup={unused}
      onJumpToOriginalPane={unused}
      onJumpToWorktree={unused}
      onResume={resume}
      onContinueInNewSession={unused}
      onResumeInNewChat={unused}
      onResumeInNewCli={unused}
      onCopyResume={unused}
      onCopyId={unused}
      onCopyPath={unused}
      onOpenLog={unused}
      onRevealLog={unused}
      onOpenCwd={unused}
      onRequestDelete={unused}
    />
  )
}
async function render(
  host: ExecutionHostScope = 'runtime:one',
  limit = 250,
  paths = ['/repo']
): Promise<void> {
  await act(async () => root?.render(createElement(Probe, { host, limit, paths })))
  await settle()
}
async function settle(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1200)
  })
}
async function refresh(force = false): Promise<void> {
  await act(async () => latest?.refresh({ background: true, force }))
  await settle()
}
beforeEach(() => {
  vi.useFakeTimers()
  resetInputQuietSchedulerForTest()
  resetStructuredAgentSessionStatusFeedsForTests()
  pendingRenders.length = 0
  resume.mockReset()
  resetAiVaultForcedRescanThrottleForTest()
  useAppStore.setState(initialState, true)
  list.mockReset().mockResolvedValue(first)
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      aiVault: {
        listSessions: list,
        cancelListSessions: vi.fn().mockResolvedValue(undefined),
        onWindowFocused: () => () => undefined
      }
    }
  })
  const container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root?.unmount())
  resetStructuredAgentSessionStatusFeedsForTests()
  root = null
  latest = null
  document.body.replaceChildren()
  useAppStore.setState(initialState, true)
  vi.useRealTimers()
})

describe('conditional panel publication', () => {
  it('keeps rows and updates the proof even when React reuses the old result identity', async () => {
    await render()
    const original = latest?.scanResult
    expect(list.mock.calls[0]?.[0]).toMatchObject({ afterFingerprint: null })
    const nextFingerprint = 'b'.repeat(64)
    list.mockResolvedValue({ ...structuredClone(first), fingerprint: nextFingerprint })
    await refresh()
    expect(latest?.scanResult).toBe(original)
    list.mockResolvedValue({
      sessions: [],
      issues: [],
      scannedAt: 'new',
      fingerprint: nextFingerprint,
      unchanged: true
    })
    await refresh()
    expect(list.mock.calls.at(-1)?.[0]).toMatchObject({ afterFingerprint: nextFingerprint })
    expect(latest?.scanResult).toBe(original)
    expect(latest?.sessions[0]?.previewMessages[0]?.text).toBe('Prompt')
    expect(latest?.loadedSessionLimit).toBe(250)
  })
})

it('cancels queued pre-clear publication while the current nonforced projection is pending', async () => {
  const summary = {
    sessionId: 'native',
    workspaceId: 'workspace',
    agent: 'codex' as const,
    latestPrompt: '',
    status: null,
    updatedAt: 1,
    providerSession: { key: 'session_id' as const, id: 'session' }
  }
  const owned = {
    ...session,
    title: 'Manual name',
    structuredSession: { sessionId: 'native', workspaceId: 'workspace' }
  }
  list.mockResolvedValue({ ...first, sessions: [owned] })
  await render('local')
  await act(async () => statusFrames.emit({ type: 'snapshot', sessions: [summary] }))
  await settle()
  markInputQuietSchedulerInput()
  list.mockResolvedValueOnce({
    ...first,
    sessions: [{ ...owned, title: 'Obsolete queued result' }]
  })
  await act(async () => latest?.refresh({ background: true }))
  expect(latest?.sessions[0]?.title).toBe('Manual name')
  let deliver = (_result: AiVaultListResult): void => {}
  list.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        deliver = resolve
      })
  )
  const baseline = list.mock.calls.length
  const { providerSession: _provider, ...detached } = summary
  await act(async () => statusFrames.emit({ type: 'status', session: detached }))
  await act(async () => {
    for (const id of ['next', 'third']) {
      statusFrames.emit({
        type: 'status',
        session: {
          ...summary,
          providerSession: { key: 'session_id', id }
        }
      })
    }
    statusFrames.emit({ type: 'status', session: detached })
  })
  await settle()
  expect(latest?.sessions[0]?.title).toBe('Manual name')
  list.mockResolvedValueOnce({ ...first, sessions: [{ ...session, title: 'Provider title' }] })
  await act(async () => deliver({ ...first, sessions: [{ ...session, title: 'Provider title' }] }))
  await settle()
  expect(latest?.sessions[0]).toMatchObject({ title: 'Provider title' })
  expect(latest?.sessions[0]?.structuredSession).toBeUndefined()
  expect(list).toHaveBeenCalledTimes(baseline + 2)
  expect(
    list.mock.calls
      .slice(baseline)
      .every(
        ([args]) =>
          typeof args === 'object' && args !== null && 'force' in args && args.force === false
      )
  ).toBe(true)
  list.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        deliver = resolve
      })
  )
  await act(async () => {
    statusFrames.emit({ type: 'status', session: summary })
    statusFrames.emit({ type: 'status', session: detached })
  })
  await act(async () => {
    root?.unmount()
    root = null
  })
  await act(async () => deliver(first))
  await settle()
  expect(list).toHaveBeenCalledTimes(baseline + 3)
})
