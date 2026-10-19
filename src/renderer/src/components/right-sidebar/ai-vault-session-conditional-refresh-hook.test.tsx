// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AiVaultListResult, AiVaultSession } from '../../../../shared/ai-vault-types'
import type { ExecutionHostScope } from '../../../../shared/execution-host'
import { useAppStore } from '@/store'
import { filterAiVaultSessions } from '../../../../shared/ai-vault-session-filters'
import { AiVaultSessionVirtualList } from './AiVaultSessionVirtualList'
import {
  markInputQuietSchedulerInput,
  resetInputQuietSchedulerForTest
} from '@/lib/input-quiet-scheduler'
import {
  resetAiVaultForcedRescanThrottleForTest,
  useAiVaultSessionRefresh
} from './ai-vault-session-refresh'

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({ index, key: index, start: index * 40 })),
    getTotalSize: () => count * 40,
    measureElement: vi.fn(),
    scrollOffset: 0
  })
}))
vi.mock('./AiVaultVirtualRow', () => ({
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
  root = null
  latest = null
  document.body.replaceChildren()
  useAppStore.setState(initialState, true)
  vi.useRealTimers()
})

describe('conditional panel publication', () => {
  it('keeps scope changes loading through actual publication and settles failures, cancellation and empty results', async () => {
    const show = async (paths: string[], noAgentsSelected = false) => {
      pendingRenders.length = 0
      await act(async () =>
        root?.render(
          <Probe
            host="local"
            limit={250}
            paths={paths}
            showList
            noAgentsSelected={noAgentsSelected}
          />
        )
      )
    }
    const loading = () => document.querySelector('[aria-busy="true"]')
    const expectPending = () => {
      expect(loading()).not.toBeNull()
      expect(document.body.textContent).not.toContain('No sessions match')
    }
    list.mockResolvedValue({ ...first, sessions: [{ ...session, cwd: '/sibling' }] })
    await show(['/repo', '/sibling'])
    await settle()
    let deliver = (_result: AiVaultListResult): void => {
      throw new Error('No pending request')
    }
    list.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          deliver = resolve
        })
    )
    await show(['/repo'])
    expect(pendingRenders[0]).toBe(true)
    expectPending()
    await show(['/repo'], true)
    expect(document.body.textContent).toContain('No agents selected')
    expect(loading()).toBeNull()
    await show(['/repo'])
    markInputQuietSchedulerInput()
    await act(async () => deliver({ ...first, scannedAt: 'workspace' }))
    expectPending()
    await settle()
    expect(loading()).toBeNull()
    const row = document.querySelector('button')
    expect(row?.textContent).toBe(session.title)
    row?.click()
    expect(resume).toHaveBeenCalledOnce()
    const applied = latest?.scanResult
    list.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          deliver = resolve
        })
    )
    await show(['/repo', '/another'])
    expect(latest?.scopePending).toBe(true)
    expect(loading()).toBeNull()
    document.querySelector('button')?.click()
    expect(resume).toHaveBeenCalledTimes(2)
    await act(async () => deliver({ ...first, cancelled: true }))
    expect(latest?.loading).toBe(false)
    expect(latest?.scanResult).toBe(applied)
    list.mockRejectedValueOnce(new Error('SSH relay is not ready'))
    await show(['/failed'])
    expect(latest?.loading).toBe(false)
    expect(latest?.error).toBe('SSH relay is not ready')
    expect(loading()).toBeNull()
    list.mockRejectedValueOnce(Object.assign(new Error('aborted'), { name: 'AbortError' }))
    await show(['/cancelled'])
    expect(latest?.loading).toBe(false)
    expect(latest?.error).toBeNull()
    expect(latest?.scanResult).toBe(applied)
    list.mockResolvedValueOnce({ ...first, sessions: [], scannedAt: 'empty' })
    await show(['/empty'])
    await settle()
    expect(document.body.textContent).toContain('No agent sessions found')
    list.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          deliver = resolve
        })
    )
    await act(async () => {
      void latest?.refresh({ background: true })
    })
    expect(loading()).toBeNull()
    expect(document.body.textContent).toContain('No agent sessions found')
    await act(async () => deliver({ ...first, sessions: [], cancelled: true }))
    expect(latest?.loading).toBe(false)
  })

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

  it('publishes changed metadata under the same scan stamp', async () => {
    await render()
    list.mockResolvedValue({
      ...first,
      fingerprint: 'b'.repeat(64),
      sessions: [
        {
          ...session,
          title: 'Changed title',
          structuredSession: { sessionId: 'owner', workspaceId: 'workspace' },
          previewMessages: [{ role: 'user', text: 'New prompt', timestamp: null }]
        }
      ]
    })
    await refresh()
    expect(latest?.sessions[0]).toMatchObject({
      title: 'Changed title',
      structuredSession: { sessionId: 'owner' }
    })
    expect(latest?.sessions[0]?.previewMessages[0]?.text).toBe('New prompt')
  })

  it('does not reuse proofs across host, depth or project switches', async () => {
    await render()
    for (const [host, limit, paths] of [
      ['runtime:two', 250, ['/repo']],
      ['runtime:two', 500, ['/repo']],
      ['runtime:two', 500, ['/other']]
    ] as const) {
      await render(host, limit, [...paths])
      expect(list.mock.calls.at(-1)?.[0]).toMatchObject({ afterFingerprint: null })
    }
  })

  it('preserves the explicit force request and ignores cancelled scans', async () => {
    await render()
    await refresh(true)
    expect(list.mock.calls.at(-1)?.[0]).toMatchObject({
      force: true,
      afterFingerprint: first.fingerprint
    })
    const original = latest?.scanResult
    list.mockResolvedValue({ sessions: [], issues: [], scannedAt: 'cancelled', cancelled: true })
    await refresh()
    expect(latest?.scanResult).toBe(original)
  })
})
