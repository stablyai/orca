// @vitest-environment happy-dom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentStatusEntry } from '../../../../../../shared/agent-status/contracts/agent-status-types'

import type { ExecutionHostScope } from '../../../../../../shared/execution-host'
import { useAppStore } from '@/store/index'
import {
  resetAiVaultForcedRescanThrottleForTest,
  useAiVaultSessionRefresh
} from './ai-vault-session-refresh'
import type {
  AiVaultListArgs,
  AiVaultListResult,
  AiVaultSession
} from '../../../../../../shared/ai-vault/contracts/ai-vault-types'
import {
  DEFAULT_AI_VAULT_SESSION_LIMIT,
  type AiVaultSessionLimit
} from '../session-list/ai-vault-session-limit'
import { resetAiVaultSessionResultCacheForTest } from './ai-vault-session-result-cache'

const EMPTY_RESULT: AiVaultListResult = {
  sessions: [],
  issues: [],
  scannedAt: '2026-07-01T00:00:00.000Z'
}

// Stands in for IndexedDB, which happy-dom lacks; it outlives the in-memory cache like a restart does.
const savedLists = vi.hoisted(() => {
  const state: {
    lists: Map<string, AiVaultListResult>
    read: ((key: string) => Promise<AiVaultListResult | null>) | null
  } = { lists: new Map(), read: null }
  return state
})
vi.mock('./ai-vault-saved-session-lists', () => ({
  readSavedAiVaultSessionList: async (key: string) => {
    const result = await (savedLists.read?.(key) ?? savedLists.lists.get(key) ?? null)
    return result && { limit: 250, result }
  },
  saveAiVaultSessionList: async (key: string, _limit: unknown, result: AiVaultListResult) => {
    savedLists.lists.set(key, result)
  },
  forgetSavedAiVaultSession: async () => {}
}))

const listSessionsMock = vi.fn<(args: AiVaultListArgs) => Promise<AiVaultListResult>>()
const cancelListSessionsMock = vi.fn<(args: { requestToken: string }) => Promise<void>>()

const onWindowFocusedMock = vi.fn(() => () => {})

const initialAppState = useAppStore.getInitialState()

const roots: Root[] = []
let latest: ReturnType<typeof useAiVaultSessionRefresh> | null = null

function HookProbe(props: {
  scopePaths: readonly string[]
  executionHostScope?: ExecutionHostScope
  sessionLimit?: AiVaultSessionLimit
  scopeOnly?: boolean
}): null {
  latest = useAiVaultSessionRefresh(
    props.scopePaths,
    props.executionHostScope ?? 'local',
    props.sessionLimit ?? DEFAULT_AI_VAULT_SESSION_LIMIT,
    props.scopeOnly ?? false
  )
  return null
}

async function renderHook(
  scopePaths: readonly string[] = [],
  executionHostScope: ExecutionHostScope = 'local',
  sessionLimit: AiVaultSessionLimit = DEFAULT_AI_VAULT_SESSION_LIMIT,
  scopeOnly = false
): Promise<void> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  await act(async () => {
    root.render(
      createElement(HookProbe, { scopePaths, executionHostScope, sessionLimit, scopeOnly })
    )
  })
}

async function rerenderHook(
  scopePaths: readonly string[] = [],
  executionHostScope: ExecutionHostScope = 'local',
  sessionLimit: AiVaultSessionLimit = DEFAULT_AI_VAULT_SESSION_LIMIT,
  scopeOnly = false
): Promise<void> {
  const root = roots.at(-1)
  if (!root) {
    throw new Error('renderHook must be called before rerenderHook')
  }
  await act(async () => {
    root.render(
      createElement(HookProbe, { scopePaths, executionHostScope, sessionLimit, scopeOnly })
    )
  })
}

async function flushMicrotasks(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

function makeAgentEntry(sessionId: string, state = 'working'): AgentStatusEntry {
  return {
    state,
    prompt: '',
    updatedAt: 0,
    stateStartedAt: 0,
    paneKey: `tab-${sessionId}:leaf-${sessionId}`,
    stateHistory: [],
    providerSession: { key: 'session_id', id: sessionId }
  } as AgentStatusEntry
}

function makeVaultSession(index: number): AiVaultSession {
  const id = `session-${index}`
  const timestamp = new Date(Date.UTC(2026, 6, 1, 0, 0, index)).toISOString()
  return {
    id,
    executionHostId: 'ssh:dev-box',
    agent: 'codex',
    sessionId: id,
    title: id,
    cwd: '/repo',
    branch: null,
    model: null,
    filePath: `/sessions/${id}.jsonl`,
    codexHome: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    modifiedAt: timestamp,
    messageCount: 1,
    totalTokens: 0,
    previewMessages: [],
    queuedMessageCount: 0,
    subagentTranscriptCount: 0,
    resumeCommand: id,
    subagent: null
  }
}

async function setAgentStatuses(entries: Record<string, AgentStatusEntry>): Promise<void> {
  await act(async () => {
    useAppStore.setState({ agentStatusByPaneKey: entries })
  })
  await flushMicrotasks()
}

function lastCallArgs(): unknown {
  return listSessionsMock.mock.calls.at(-1)?.[0]
}

beforeEach(() => {
  vi.useFakeTimers()
  listSessionsMock.mockReset().mockResolvedValue(EMPTY_RESULT)
  cancelListSessionsMock.mockReset().mockResolvedValue()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test-only window.api shim
  ;(window as any).api = {
    aiVault: {
      listSessions: listSessionsMock,
      cancelListSessions: cancelListSessionsMock,
      onWindowFocused: onWindowFocusedMock
    }
  }
  resetAiVaultForcedRescanThrottleForTest()
  savedLists.lists.clear()
  savedLists.read = null
  useAppStore.setState(initialAppState, true)
})

afterEach(() => {
  roots.splice(0).forEach((root) => act(() => root.unmount()))
  document.body.replaceChildren()
  useAppStore.setState(initialAppState, true)
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('useAiVaultSessionRefresh refocus behavior', () => {
  it('does not apply stale results after the host scope changes mid-scan', async () => {
    let resolveLocal: ((result: AiVaultListResult) => void) | null = null
    let resolveSsh: ((result: AiVaultListResult) => void) | null = null
    listSessionsMock
      .mockImplementationOnce(
        () => new Promise<AiVaultListResult>((resolve) => (resolveLocal = resolve))
      )
      .mockImplementationOnce(
        () => new Promise<AiVaultListResult>((resolve) => (resolveSsh = resolve))
      )

    await renderHook([], 'local')
    expect(listSessionsMock).toHaveBeenCalledTimes(1)

    await rerenderHook(['/remote/repo'], 'ssh:dev-box')
    expect(listSessionsMock).toHaveBeenCalledTimes(1)
    expect(cancelListSessionsMock).toHaveBeenCalledTimes(1)

    await act(async () => {
      resolveLocal?.({ ...EMPTY_RESULT, scannedAt: '2026-07-01T00:00:01.000Z' })
    })
    await flushMicrotasks()

    expect(latest?.scanResult).toBeNull()
    expect(listSessionsMock).toHaveBeenCalledTimes(2)
    expect(lastCallArgs()).toMatchObject({
      executionHostScope: 'ssh:dev-box',
      scopePaths: ['/remote/repo']
    })

    await act(async () => {
      resolveSsh?.({ ...EMPTY_RESULT, scannedAt: '2026-07-01T00:00:02.000Z' })
    })
    await flushMicrotasks()

    expect(latest?.scanResult?.scannedAt).toBe('2026-07-01T00:00:02.000Z')
  })

  it('does not show Workspace-only rows under All while All loads or after it fails', async () => {
    let failAll: (error: Error) => void = () => {}
    listSessionsMock.mockImplementation((args) =>
      args.scopeOnly
        ? Promise.resolve({ ...EMPTY_RESULT, sessions: [makeVaultSession(1)] })
        : new Promise((_resolve, reject) => {
            failAll = reject
          })
    )
    await renderHook(['/repo'], 'local', 250, true)
    await flushMicrotasks()
    expect(latest?.sessions.map((session) => session.id)).toEqual(['session-1'])

    await rerenderHook(['/repo'], 'local', 250, false)
    await flushMicrotasks()
    expect(latest?.sessions).toEqual([])
    expect(latest?.loading).toBe(true)

    await act(async () => failAll(new Error('scan failed')))
    await flushMicrotasks()
    expect(latest?.sessions).toEqual([])
  })

  it('keeps Workspace rows while a deeper Workspace scan loads and after it fails', async () => {
    let failDeeper: (error: Error) => void = () => {}
    listSessionsMock.mockImplementation((args) =>
      args.limit === 250
        ? Promise.resolve({ ...EMPTY_RESULT, sessions: [makeVaultSession(1)] })
        : new Promise((_resolve, reject) => {
            failDeeper = reject
          })
    )
    await renderHook(['/repo'], 'local', 250, true)
    await flushMicrotasks()

    await rerenderHook(['/repo'], 'local', 500, true)
    await flushMicrotasks()
    expect(latest?.sessions.map((session) => session.id)).toEqual(['session-1'])

    await act(async () => failDeeper(new Error('scan failed')))
    await flushMicrotasks()
    expect(latest?.sessions.map((session) => session.id)).toEqual(['session-1'])
  })

  it('replaces a stuck scan on manual Refresh without cancelling an automatic rescan', async () => {
    let resolveInitial: ((result: AiVaultListResult) => void) | null = null
    let resolveReplacement: ((result: AiVaultListResult) => void) | null = null
    listSessionsMock
      .mockImplementationOnce(
        () => new Promise<AiVaultListResult>((resolve) => (resolveInitial = resolve))
      )
      .mockImplementationOnce(
        () => new Promise<AiVaultListResult>((resolve) => (resolveReplacement = resolve))
      )
    await renderHook()
    expect(latest?.loading).toBe(true)

    await setAgentStatuses({ 'pane-1': makeAgentEntry('new-session') })
    expect(listSessionsMock).toHaveBeenCalledTimes(1)
    expect(cancelListSessionsMock).not.toHaveBeenCalled()

    cancelListSessionsMock.mockImplementationOnce(async () => {
      resolveInitial?.({
        ...EMPTY_RESULT,
        sessions: [makeVaultSession(1)],
        cancelled: true
      })
    })
    await act(async () => {
      await latest?.refresh({ force: true })
    })
    await flushMicrotasks()

    expect(cancelListSessionsMock).toHaveBeenCalledExactlyOnceWith({
      requestToken: listSessionsMock.mock.calls[0]?.[0].requestToken
    })
    expect(listSessionsMock).toHaveBeenCalledTimes(2)
    expect(listSessionsMock.mock.calls[1]?.[0]).toMatchObject({ force: true })
    expect(latest?.scanResult).toBeNull()
    expect(latest?.error).toBeNull()

    await act(async () => {
      resolveReplacement?.({ ...EMPTY_RESULT, sessions: [makeVaultSession(2)] })
    })
    expect(latest?.sessions.map((session) => session.id)).toEqual(['session-2'])
  })
})

function deferredList(): {
  promise: Promise<AiVaultListResult>
  resolve: (result: AiVaultListResult) => void
} {
  let resolve: (result: AiVaultListResult) => void = () => {}
  const promise = new Promise<AiVaultListResult>((done) => (resolve = done))
  return { promise, resolve }
}

async function restartWithScanPending(): Promise<(result: AiVaultListResult) => void> {
  listSessionsMock.mockResolvedValueOnce({
    ...EMPTY_RESULT,
    sessions: [makeVaultSession(1), makeVaultSession(2)]
  })
  await renderHook(['/repo'], 'local', DEFAULT_AI_VAULT_SESSION_LIMIT, true)
  await flushMicrotasks()
  expect(latest?.sessions.map((session) => session.id)).toEqual(['session-1', 'session-2'])
  roots.splice(0).forEach((root) => act(() => root.unmount()))
  resetAiVaultSessionResultCacheForTest()
  const scan = deferredList()
  listSessionsMock.mockReturnValueOnce(scan.promise)
  return scan.resolve
}

describe('useAiVaultSessionRefresh after a restart', () => {
  it('shows the last list as refreshing until the rescan replaces it', async () => {
    const resolveScan = await restartWithScanPending()

    await renderHook(['/repo'], 'local', DEFAULT_AI_VAULT_SESSION_LIMIT, true)
    await flushMicrotasks()

    expect(latest?.sessions.map((session) => session.id)).toEqual(['session-1', 'session-2'])
    expect(latest?.loading).toBe(true)
    expect(latest?.scopePending).toBe(true)

    await act(async () => {
      resolveScan({ ...EMPTY_RESULT, sessions: [makeVaultSession(2)] })
    })
    await flushMicrotasks()

    expect(latest?.sessions.map((session) => session.id)).toEqual(['session-2'])
    expect(latest?.loading).toBe(false)
  })

  it('keeps the rescan when the saved list answers after it', async () => {
    const resolveScan = await restartWithScanPending()
    const read = deferredList()
    savedLists.read = () => read.promise

    await renderHook(['/repo'], 'local', DEFAULT_AI_VAULT_SESSION_LIMIT, true)
    await act(async () => {
      resolveScan({ ...EMPTY_RESULT, sessions: [makeVaultSession(3)] })
    })
    await flushMicrotasks()
    await act(async () => {
      read.resolve({ ...EMPTY_RESULT, sessions: [makeVaultSession(1)] })
    })
    await flushMicrotasks()

    expect(latest?.sessions.map((session) => session.id)).toEqual(['session-3'])
    expect(latest?.loading).toBe(false)
  })
})

// Plain HTTP hides crypto.randomUUID; fallback tokens must remain v4 UUIDs (#18096).
