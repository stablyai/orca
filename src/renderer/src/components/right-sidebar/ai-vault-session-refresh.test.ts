// @vitest-environment happy-dom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import type { AiVaultListResult, AiVaultSession } from '../../../../shared/ai-vault-types'
import type { ExecutionHostScope } from '../../../../shared/execution-host'
import { useAppStore } from '@/store'
import {
  isAiVaultScanCancellation,
  resetAiVaultForcedRescanThrottleForTest,
  useAiVaultSessionRefresh
} from './ai-vault-session-refresh'
import { DEFAULT_AI_VAULT_SESSION_LIMIT, type AiVaultSessionLimit } from './ai-vault-session-limit'

const EMPTY_RESULT: AiVaultListResult = {
  sessions: [],
  issues: [],
  scannedAt: '2026-07-01T00:00:00.000Z'
}

const THROTTLE_MS = 30_000

const listSessionsMock = vi.fn<(args: unknown) => Promise<AiVaultListResult>>()
const cancelListSessionsMock = vi.fn<() => Promise<void>>()

// Captures the hook's subscription to the main-process window-focus push.
let windowFocusCallback: (() => void) | null = null
const onWindowFocusedMock = vi.fn((callback: () => void) => {
  windowFocusCallback = callback
  return () => {
    windowFocusCallback = null
  }
})

async function fireWindowFocused(): Promise<void> {
  await act(async () => {
    windowFocusCallback?.()
  })
  await flushMicrotasks()
}

const initialAppState = useAppStore.getInitialState()

describe('isAiVaultScanCancellation', () => {
  it('recognises a cancellation through the IPC error wrapper', () => {
    expect(
      isAiVaultScanCancellation(
        new Error(
          "Error invoking remote method 'aiVault:listSessions': Error: Agent Session History scan was cancelled"
        )
      )
    ).toBe(true)
  })

  it('recognises an in-process AbortError', () => {
    const error = new Error('aborted')
    error.name = 'AbortError'
    expect(isAiVaultScanCancellation(error)).toBe(true)
  })

  it('leaves a real scan failure reportable', () => {
    expect(isAiVaultScanCancellation(new Error('SSH relay is not ready'))).toBe(false)
    expect(isAiVaultScanCancellation('nope')).toBe(false)
  })
})

const roots: Root[] = []
let latest: ReturnType<typeof useAiVaultSessionRefresh> | null = null

function HookProbe(props: {
  scopePaths: readonly string[]
  executionHostScope?: ExecutionHostScope
  sessionLimit?: AiVaultSessionLimit
}): null {
  latest = useAiVaultSessionRefresh(
    props.scopePaths,
    props.executionHostScope ?? 'local',
    props.sessionLimit ?? DEFAULT_AI_VAULT_SESSION_LIMIT
  )
  return null
}

async function renderHook(
  scopePaths: readonly string[] = [],
  executionHostScope: ExecutionHostScope = 'local',
  sessionLimit: AiVaultSessionLimit = DEFAULT_AI_VAULT_SESSION_LIMIT
): Promise<void> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  await act(async () => {
    root.render(createElement(HookProbe, { scopePaths, executionHostScope, sessionLimit }))
  })
}

async function rerenderHook(
  scopePaths: readonly string[] = [],
  executionHostScope: ExecutionHostScope = 'local',
  sessionLimit: AiVaultSessionLimit = DEFAULT_AI_VAULT_SESSION_LIMIT
): Promise<void> {
  const root = roots.at(-1)
  if (!root) {
    throw new Error('renderHook must be called before rerenderHook')
  }
  await act(async () => {
    root.render(createElement(HookProbe, { scopePaths, executionHostScope, sessionLimit }))
  })
}

async function flushMicrotasks(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

async function dispatch(target: EventTarget, type: string): Promise<void> {
  await act(async () => {
    target.dispatchEvent(new Event(type))
  })
  await flushMicrotasks()
}

async function advance(ms: number): Promise<void> {
  await act(async () => {
    vi.advanceTimersByTime(ms)
  })
  await flushMicrotasks()
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
  it('uses the shared scan cache on local panel entry', async () => {
    await renderHook()
    await flushMicrotasks()

    expect(listSessionsMock).toHaveBeenCalledTimes(1)
    expect(listSessionsMock.mock.calls[0]?.[0]).toMatchObject({
      executionHostScope: 'local',
      force: false
    })
  })

  it.each(['ssh:dev-box', 'runtime:remote-server'] as const)(
    'uses the cache on %s panel entry',
    async (executionHostScope) => {
      await renderHook(['/repo'], executionHostScope)
      await flushMicrotasks()

      expect(listSessionsMock).toHaveBeenCalledTimes(1)
      expect(lastCallArgs()).toMatchObject({
        executionHostScope,
        scopePaths: ['/repo'],
        force: false
      })

      await advance(THROTTLE_MS + 1)
      expect(listSessionsMock).toHaveBeenCalledTimes(1)
    }
  )

  it('passes the requested execution host scope to the scanner', async () => {
    await renderHook(['/repo'], 'ssh:dev-box')
    await flushMicrotasks()

    expect(listSessionsMock).toHaveBeenCalledTimes(1)
    expect(lastCallArgs()).toMatchObject({
      executionHostScope: 'ssh:dev-box',
      scopePaths: ['/repo']
    })
  })

  it('re-scans with the selected history depth', async () => {
    await renderHook(['/repo'], 'ssh:dev-box')
    await flushMicrotasks()

    await rerenderHook(['/repo'], 'ssh:dev-box', 1000)
    await flushMicrotasks()

    expect(listSessionsMock).toHaveBeenCalledTimes(2)
    expect(lastCallArgs()).toMatchObject({ limit: 1000, force: false })
  })

  it('reuses a loaded larger depth when lowering and raising within its coverage', async () => {
    const loaded = {
      ...EMPTY_RESULT,
      sessions: Array.from({ length: 600 }, (_, index) => makeVaultSession(index))
    }
    listSessionsMock.mockResolvedValueOnce(loaded)
    await renderHook([], 'ssh:dev-box', 1000)
    await flushMicrotasks()

    await rerenderHook([], 'ssh:dev-box', 250)
    await flushMicrotasks()
    expect(latest?.sessions).toHaveLength(250)

    await rerenderHook([], 'ssh:dev-box', 500)
    await flushMicrotasks()
    expect(latest?.sessions).toHaveLength(500)
    expect(listSessionsMock).toHaveBeenCalledTimes(1)
  })

  it('reuses the rendered result after the panel remounts on a tab switch', async () => {
    const loaded = { ...EMPTY_RESULT, sessions: [makeVaultSession(1)] }
    listSessionsMock.mockResolvedValueOnce(loaded)
    await renderHook(['/repo'], 'ssh:dev-box', 250)
    await flushMicrotasks()

    roots.splice(0).forEach((root) => act(() => root.unmount()))
    await renderHook(['/repo'], 'ssh:dev-box', 250)
    await flushMicrotasks()

    expect(listSessionsMock).toHaveBeenCalledTimes(1)
    expect(latest?.sessions).toEqual(loaded.sessions)
  })

  it('reuses each workspace result when switching back across tabs', async () => {
    listSessionsMock
      .mockResolvedValueOnce({ ...EMPTY_RESULT, sessions: [makeVaultSession(1)] })
      .mockResolvedValueOnce({ ...EMPTY_RESULT, sessions: [makeVaultSession(2)] })
    await renderHook(['/repo-a'], 'ssh:dev-box', 250)
    await flushMicrotasks()

    await rerenderHook(['/repo-b'], 'ssh:dev-box', 250)
    await flushMicrotasks()
    await rerenderHook(['/repo-a'], 'ssh:dev-box', 250)
    await flushMicrotasks()

    expect(listSessionsMock).toHaveBeenCalledTimes(2)
    expect(latest?.sessions[0]?.id).toBe('session-1')
  })

  it('requests an uncapped scan for Unlimited', async () => {
    await renderHook([], 'ssh:dev-box', 'unlimited')
    await flushMicrotasks()

    expect(lastCallArgs()).toMatchObject({ limit: undefined, unlimited: true, force: false })
  })

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

  it('refreshes from the shared cache on refocus', async () => {
    await renderHook()
    await flushMicrotasks()
    expect(listSessionsMock).toHaveBeenCalledTimes(1)

    await fireWindowFocused()

    expect(listSessionsMock).toHaveBeenCalledTimes(2)
    expect(lastCallArgs()).toMatchObject({ force: false })
  })

  it('does not force transcript scans for refocus events', async () => {
    await renderHook()
    await flushMicrotasks()
    expect(listSessionsMock).toHaveBeenCalledTimes(1)

    await fireWindowFocused()
    expect(listSessionsMock).toHaveBeenCalledTimes(2)
    expect(lastCallArgs()).toMatchObject({ force: false })
  })

  it('ignores focus/visibility events while the document is hidden', async () => {
    await renderHook()
    await flushMicrotasks()
    expect(listSessionsMock).toHaveBeenCalledTimes(1)

    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    await advance(THROTTLE_MS + 1)
    await dispatch(document, 'visibilitychange')
    await fireWindowFocused()
    await advance(THROTTLE_MS + 1)

    expect(listSessionsMock).toHaveBeenCalledTimes(1)
  })

  it('stops listening after unmount', async () => {
    await renderHook()
    await flushMicrotasks()
    expect(listSessionsMock).toHaveBeenCalledTimes(1)

    roots.splice(0).forEach((root) => act(() => root.unmount()))
    await fireWindowFocused()
    await dispatch(document, 'visibilitychange')

    expect(listSessionsMock).toHaveBeenCalledTimes(1)
    expect(cancelListSessionsMock).toHaveBeenCalledTimes(1)
  })

  it('does not raise the loading flag for refocus refreshes', async () => {
    await renderHook()
    await flushMicrotasks()
    await advance(THROTTLE_MS + 1)

    let resolveScan: ((result: AiVaultListResult) => void) | null = null
    listSessionsMock.mockImplementationOnce(
      () => new Promise<AiVaultListResult>((resolve) => (resolveScan = resolve))
    )
    await fireWindowFocused()

    expect(listSessionsMock).toHaveBeenCalledTimes(2)
    expect(latest?.loading).toBe(false)

    await act(async () => {
      resolveScan?.({ ...EMPTY_RESULT, scannedAt: '2026-07-01T00:00:01.000Z' })
    })
    await flushMicrotasks()
    expect(latest?.loading).toBe(false)
  })

  it('skips state updates when a refresh returns the applied snapshot', async () => {
    await renderHook()
    await flushMicrotasks()
    const firstResult = latest?.scanResult

    // Same scannedAt = the snapshot already on screen was replayed.
    listSessionsMock.mockResolvedValueOnce({ ...EMPTY_RESULT })
    await advance(THROTTLE_MS + 1)
    await fireWindowFocused()
    expect(latest?.scanResult).toBe(firstResult)

    // A reminted stamp with the same empty body is still the snapshot on screen.
    listSessionsMock.mockResolvedValueOnce({
      ...EMPTY_RESULT,
      scannedAt: '2026-07-01T00:00:02.000Z'
    })
    await advance(THROTTLE_MS + 1)
    await fireWindowFocused()
    expect(latest?.scanResult).toBe(firstResult)
  })

  // An 'all' result is a merge of legs on independent clocks, stamped with the
  // newest leg. A paired host whose clock lags the desktop can return new
  // sessions while the merged stamp repeats, so the stamp guard above must not
  // decide anything under 'all' — only the structural reconcile may.
  it('applies a changed all-host result whose merged scannedAt stood still', async () => {
    const pinned = '2026-07-01T00:00:00.000Z'
    listSessionsMock.mockResolvedValueOnce({
      sessions: [makeVaultSession(1)],
      issues: [],
      scannedAt: pinned
    })
    await renderHook([], 'all')
    await flushMicrotasks()
    expect(latest?.sessions).toHaveLength(1)

    listSessionsMock.mockResolvedValueOnce({
      sessions: [makeVaultSession(1), makeVaultSession(2)],
      issues: [],
      scannedAt: pinned
    })
    await advance(THROTTLE_MS + 1)
    await fireWindowFocused()

    expect(latest?.sessions).toHaveLength(2)
    expect(latest?.sessions[1]?.id).toBe('session-2')
  })

  // The main process routes an empty or unrecognized scope to the same all-host
  // merge, so the renderer has to read those as merged too or the guard returns
  // for exactly the results it cannot reason about.
  it('treats a scope that normalizes to all-host as merged', async () => {
    const pinned = '2026-07-01T00:00:00.000Z'
    listSessionsMock.mockResolvedValueOnce({
      sessions: [makeVaultSession(1)],
      issues: [],
      scannedAt: pinned
    })
    await renderHook([], '' as ExecutionHostScope)
    await flushMicrotasks()
    expect(latest?.sessions).toHaveLength(1)

    listSessionsMock.mockResolvedValueOnce({
      sessions: [makeVaultSession(1), makeVaultSession(2)],
      issues: [],
      scannedAt: pinned
    })
    await advance(THROTTLE_MS + 1)
    await fireWindowFocused()

    expect(latest?.sessions).toHaveLength(2)
  })

  it('still reuses all-host identity when a repeated stamp carries an unchanged body', async () => {
    const pinned = '2026-07-01T00:00:00.000Z'
    const first: AiVaultListResult = {
      sessions: [makeVaultSession(1)],
      issues: [],
      scannedAt: pinned
    }
    listSessionsMock.mockResolvedValueOnce(first)
    await renderHook([], 'all')
    await flushMicrotasks()
    const applied = latest?.scanResult
    const appliedSessions = latest?.sessions

    // Dropping the stamp guard for 'all' must not reintroduce the churn: the
    // reconcile still has to recognise an independently cloned identical body.
    listSessionsMock.mockResolvedValueOnce(structuredClone(first))
    await advance(THROTTLE_MS + 1)
    await fireWindowFocused()

    expect(latest?.scanResult).toBe(applied)
    expect(latest?.sessions).toBe(appliedSessions)
  })

  it('keeps session row identity when a reminted scan is a structuredClone of the same nested rows', async () => {
    const session = makeVaultSession(1)
    const first: AiVaultListResult = {
      sessions: [
        {
          ...session,
          previewMessages: [
            {
              role: 'user',
              text: 'keep session list identity on reminted scannedAt',
              timestamp: session.modifiedAt
            },
            {
              role: 'assistant',
              text: 'reuse previous row refs when the transcript did not change',
              timestamp: session.modifiedAt
            }
          ],
          previewMessagesTruncated: true,
          lastUserPrompt: 'keep session list identity on reminted scannedAt',
          subagent: {
            parentSessionId: session.sessionId,
            agentType: 'Explore',
            status: 'completed'
          }
        }
      ],
      issues: [],
      scannedAt: '2026-07-01T00:00:00.000Z'
    }
    listSessionsMock.mockResolvedValueOnce(first)
    await renderHook()
    await flushMicrotasks()
    const appliedSessions = latest?.sessions
    const appliedResult = latest?.scanResult
    expect(appliedSessions?.[0]?.previewMessages).toHaveLength(2)

    const reminted = structuredClone(first)
    reminted.scannedAt = '2026-07-01T00:00:15.000Z'
    expect(reminted.sessions).not.toBe(first.sessions)
    expect(reminted.sessions[0]).not.toBe(first.sessions[0])
    expect(reminted.sessions[0]?.previewMessages).not.toBe(first.sessions[0]?.previewMessages)

    listSessionsMock.mockResolvedValueOnce(reminted)
    await advance(THROTTLE_MS + 1)
    await fireWindowFocused()

    expect(latest?.sessions).toBe(appliedSessions)
    expect(latest?.sessions[0]).toBe(appliedSessions?.[0])
    expect(latest?.sessions[0]?.previewMessages).toBe(appliedSessions?.[0]?.previewMessages)
    expect(latest?.scanResult).toBe(appliedResult)
  })

  it('replaces the changed row when a reminted scan edits nested preview text', async () => {
    const session = makeVaultSession(1)
    const sibling = makeVaultSession(2)
    const first: AiVaultListResult = {
      sessions: [
        {
          ...session,
          previewMessages: [{ role: 'user', text: 'original ask', timestamp: session.modifiedAt }]
        },
        sibling
      ],
      issues: [],
      scannedAt: '2026-07-01T00:00:00.000Z'
    }
    listSessionsMock.mockResolvedValueOnce(first)
    await renderHook()
    await flushMicrotasks()
    const appliedSessions = latest?.sessions
    expect(appliedSessions).toHaveLength(2)

    const reminted = structuredClone(first)
    reminted.scannedAt = '2026-07-01T00:00:15.000Z'
    const changed = reminted.sessions[0]
    const preview = changed?.previewMessages[0]
    if (!changed || !preview) {
      throw new Error('expected a nested preview message')
    }
    reminted.sessions[0] = {
      ...changed,
      previewMessages: [{ ...preview, text: 'follow-up ask' }]
    }

    listSessionsMock.mockResolvedValueOnce(reminted)
    await advance(THROTTLE_MS + 1)
    await fireWindowFocused()

    expect(latest?.sessions).not.toBe(appliedSessions)
    expect(latest?.sessions[0]).not.toBe(appliedSessions?.[0])
    expect(latest?.sessions[0]?.previewMessages[0]?.text).toBe('follow-up ask')
    expect(latest?.sessions[1]).toBe(appliedSessions?.[1])
  })

  it('appends a new session on refocus and keeps the surviving row identity', async () => {
    const first: AiVaultListResult = {
      sessions: [makeVaultSession(1)],
      issues: [],
      scannedAt: '2026-07-01T00:00:00.000Z'
    }
    listSessionsMock.mockResolvedValueOnce(first)
    await renderHook()
    await flushMicrotasks()
    const surviving = latest?.sessions[0]
    const previous = first.sessions[0]
    expect(surviving?.id).toBe('session-1')
    if (!previous) {
      throw new Error('expected the first scan to include a session')
    }

    listSessionsMock.mockResolvedValueOnce({
      sessions: [structuredClone(previous), makeVaultSession(2)],
      issues: [],
      scannedAt: '2026-07-01T00:00:15.000Z'
    })
    await advance(THROTTLE_MS + 1)
    await fireWindowFocused()

    expect(latest?.sessions).toHaveLength(2)
    expect(latest?.sessions[0]).toBe(surviving)
    expect(latest?.sessions[1]?.id).toBe('session-2')
  })

  it('keeps the current list when a superseded scan resolves cancelled', async () => {
    await renderHook()
    await flushMicrotasks()
    const applied = latest?.scanResult

    listSessionsMock.mockResolvedValueOnce({
      sessions: [],
      issues: [],
      scannedAt: '2026-07-01T00:00:09.000Z',
      cancelled: true
    })
    await advance(THROTTLE_MS + 1)
    await fireWindowFocused()

    expect(latest?.scanResult).toBe(applied)
    expect(latest?.error).toBeNull()
  })

  it('keeps the manual refresh button forcing a cache bypass', async () => {
    await renderHook()
    await flushMicrotasks()

    await act(async () => {
      await latest?.refresh({ force: true })
    })

    expect(lastCallArgs()).toMatchObject({ force: true })
  })

  it('keeps refocus cache-backed after a manual force refresh', async () => {
    await renderHook()
    await flushMicrotasks()

    await advance(THROTTLE_MS + 1)
    await act(async () => {
      await latest?.refresh({ force: true })
    })
    expect(listSessionsMock).toHaveBeenCalledTimes(2)

    await fireWindowFocused()
    expect(listSessionsMock).toHaveBeenCalledTimes(3)
    expect(lastCallArgs()).toMatchObject({ force: false })
  })
})

describe('useAiVaultSessionRefresh in-app agent session behavior', () => {
  it('force re-scans when an agent session starts inside Orca', async () => {
    await renderHook()
    await flushMicrotasks()
    expect(listSessionsMock).toHaveBeenCalledTimes(1)

    await advance(THROTTLE_MS + 1)
    await setAgentStatuses({ 'pane-1': makeAgentEntry('sess-1') })

    expect(listSessionsMock).toHaveBeenCalledTimes(2)
    expect(lastCallArgs()).toMatchObject({ force: true })
  })

  it('defers an in-throttle session start to a trailing forced scan', async () => {
    await renderHook()
    await flushMicrotasks()
    expect(listSessionsMock).toHaveBeenCalledTimes(1)

    await setAgentStatuses({ 'pane-1': makeAgentEntry('sess-1') })
    expect(listSessionsMock).toHaveBeenCalledTimes(2)

    await setAgentStatuses({ 'pane-2': makeAgentEntry('sess-2') })
    expect(listSessionsMock).toHaveBeenCalledTimes(2)

    await advance(THROTTLE_MS + 1)
    expect(listSessionsMock).toHaveBeenCalledTimes(3)
    expect(lastCallArgs()).toMatchObject({ force: true })
  })

  it('re-budgets a trailing agent scan after a manual refresh', async () => {
    await renderHook()
    await flushMicrotasks()

    await setAgentStatuses({ 'pane-1': makeAgentEntry('sess-1') })
    await advance(10_000)
    await setAgentStatuses({ 'pane-2': makeAgentEntry('sess-2') })
    await advance(10_000)
    await act(async () => {
      await latest?.refresh({ force: true })
    })

    await advance(10_001)
    expect(listSessionsMock).toHaveBeenCalledTimes(3)

    await advance(19_999)
    expect(listSessionsMock).toHaveBeenCalledTimes(4)
    expect(lastCallArgs()).toMatchObject({ force: true })
  })

  it('ignores agent activity on already-known sessions', async () => {
    await renderHook()
    await flushMicrotasks()
    await advance(THROTTLE_MS + 1)
    await setAgentStatuses({ 'pane-1': makeAgentEntry('sess-1', 'working') })
    expect(listSessionsMock).toHaveBeenCalledTimes(2)

    // Message/tool pings and state transitions on a known session must not
    // re-trigger — only a session id we haven't seen does.
    await advance(THROTTLE_MS + 1)
    await setAgentStatuses({ 'pane-1': makeAgentEntry('sess-1', 'done') })
    expect(listSessionsMock).toHaveBeenCalledTimes(2)

    // A closed pane re-opening the same session is not a new session either.
    await setAgentStatuses({})
    await setAgentStatuses({ 'pane-1': makeAgentEntry('sess-1', 'working') })
    expect(listSessionsMock).toHaveBeenCalledTimes(2)

    await setAgentStatuses({ 'pane-2': makeAgentEntry('sess-2', 'working') })
    expect(listSessionsMock).toHaveBeenCalledTimes(3)
  })

  // Reported against an adhoc build: a workspace whose editor was loading files fine still showed
  // "SSH relay is not ready" with "0 shown · 0 recent" in this panel. That error is what the relay
  // throws before it is ready, which is ordinary at startup and for the window a reconnect leaves it
  // not-ready — but nothing here retried on the relay simply becoming ready. The remaining triggers
  // are mount, window refocus and a new agent session id, so the error stuck while the rest of the
  // workspace worked. The file explorer already recovers off this same signal.
  it('retries after a not-ready failure once the SSH connection lands', async () => {
    listSessionsMock.mockRejectedValueOnce(new Error('SSH relay is not ready'))
    await renderHook(['/home/neil/projects/orca'])
    await flushMicrotasks()

    expect(latest?.error).toBe('SSH relay is not ready')
    const callsWhileBroken = listSessionsMock.mock.calls.length

    listSessionsMock.mockResolvedValue(EMPTY_RESULT)
    await act(async () => {
      useAppStore.setState({ sshConnectedGeneration: 1 })
    })
    await flushMicrotasks()

    expect(
      listSessionsMock.mock.calls.length,
      'the panel never retried after SSH became ready'
    ).toBeGreaterThan(callsWhileBroken)
    expect(latest?.error).toBeNull()
  })

  it('does not rescan on a connection bump when the last listing succeeded', async () => {
    // Gated on a prior error so a local workspace, or one that already listed fine, does not rescan
    // every time some unrelated host connects.
    listSessionsMock.mockResolvedValue(EMPTY_RESULT)
    await renderHook(['/home/neil/projects/orca'])
    await flushMicrotasks()

    expect(latest?.error).toBeNull()
    const callsWhileHealthy = listSessionsMock.mock.calls.length

    await act(async () => {
      useAppStore.setState({ sshConnectedGeneration: 1 })
    })
    await flushMicrotasks()

    expect(listSessionsMock.mock.calls.length).toBe(callsWhileHealthy)
  })
})
