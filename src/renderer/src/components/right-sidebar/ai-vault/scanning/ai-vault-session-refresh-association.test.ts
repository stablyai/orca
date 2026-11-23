import '@/store/slices/agent-status/status-ownership/accepted-agent-statuses'
// @vitest-environment happy-dom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useAppStore } from '@/store/index'
import { useAiVaultSessionRefresh } from './ai-vault-session-refresh'
import type {
  AiVaultListArgs,
  AiVaultListResult,
  AiVaultSession
} from '../../../../../../shared/ai-vault/contracts/ai-vault-types'
import { DEFAULT_AI_VAULT_SESSION_LIMIT } from '../session-list/ai-vault-session-limit'
import { markInputQuietSchedulerInput } from '@/lib/window-activity/input-quiet-scheduler'

// Chat-link associations drive this path; a controllable observation stands in for the host feeds.
const association = vi.hoisted(() => ({ revision: 0, listeners: new Set<() => void>() }))
vi.mock('./ai-vault-association-observation', () => {
  const observation = {
    getSnapshot: () => String(association.revision),
    subscribe: (listener: () => void) => {
      association.listeners.add(listener)
      return () => association.listeners.delete(listener)
    }
  }
  return { useAiVaultAssociationObservation: () => observation }
})
vi.mock('./ai-vault-saved-session-lists', () => ({
  readSavedAiVaultSessionList: async () => null,
  saveAiVaultSessionList: async () => {},
  forgetSavedAiVaultSession: async () => {}
}))
vi.mock('./ai-vault-session-list-request', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readCachedAiVaultSessionList: () => null,
  readLastAiVaultSessionList: async () => null
}))

const EMPTY_RESULT: AiVaultListResult = {
  sessions: [],
  issues: [],
  scannedAt: '2026-07-01T00:00:00.000Z'
}
const listSessionsMock = vi.fn<(args: AiVaultListArgs) => Promise<AiVaultListResult>>()
const initialAppState = useAppStore.getInitialState()
const roots: Root[] = []
let latest: ReturnType<typeof useAiVaultSessionRefresh> | null = null
// Render-phase samples (not only commits): each render's flags and rows.
const renders: { loading: boolean; refreshing: boolean; ids: string[] }[] = []

function HookProbe(): null {
  latest = useAiVaultSessionRefresh(['/repo'], 'local', DEFAULT_AI_VAULT_SESSION_LIMIT, true)
  renders.push({
    loading: latest.loading,
    refreshing: latest.refreshing,
    ids: latest.sessions.map((session) => session.id)
  })
  return null
}

function session(index: number): AiVaultSession {
  const id = `session-${index}`
  const at = new Date(Date.UTC(2026, 6, 1, 0, 0, index)).toISOString()
  return {
    id,
    executionHostId: 'local',
    agent: 'codex',
    sessionId: id,
    title: id,
    cwd: '/repo',
    branch: null,
    model: null,
    filePath: `/sessions/${id}.jsonl`,
    codexHome: null,
    createdAt: at,
    updatedAt: at,
    modifiedAt: at,
    messageCount: 1,
    totalTokens: 0,
    previewMessages: [],
    queuedMessageCount: 0,
    subagentTranscriptCount: 0,
    resumeCommand: id,
    subagent: null
  }
}

function deferredList(): {
  promise: Promise<AiVaultListResult>
  resolve: (result: AiVaultListResult) => void
  reject: (error: Error) => void
} {
  let resolve: (result: AiVaultListResult) => void = () => {}
  let reject: (error: Error) => void = () => {}
  const promise = new Promise<AiVaultListResult>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

async function mountWithRows(): Promise<void> {
  listSessionsMock.mockResolvedValueOnce({ ...EMPTY_RESULT, sessions: [session(1)] })
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  await act(async () => root.render(createElement(HookProbe)))
  await flush()
}

function changeAssociations(): void {
  association.revision += 1
  association.listeners.forEach((listener) => listener())
}

const ids = (): string[] | undefined => latest?.sessions.map((s) => s.id)

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] })
  markInputQuietSchedulerInput()
  vi.advanceTimersByTime(1_000)
  association.revision = 0
  association.listeners.clear()
  listSessionsMock.mockReset().mockResolvedValue(EMPTY_RESULT)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test-only window.api shim
  ;(window as any).api = {
    aiVault: {
      listSessions: listSessionsMock,
      cancelListSessions: vi.fn(async () => {}),
      onWindowFocused: () => () => {}
    }
  }
  useAppStore.setState(initialAppState, true)
})

afterEach(() => {
  roots.splice(0).forEach((root) => act(() => root.unmount()))
  document.body.replaceChildren()
  useAppStore.setState(initialAppState, true)
  vi.useRealTimers()
  renders.length = 0
})

describe('useAiVaultSessionRefresh when chat-link associations change mid-refresh', () => {
  it('drops the stale result, clears the flags, keeps the rows and relaunches a background refresh', async () => {
    await mountWithRows()
    const foreground = deferredList()
    listSessionsMock.mockReturnValueOnce(foreground.promise)
    await act(async () => void latest?.refresh({ force: true }))
    expect(latest?.refreshing).toBe(true)

    const background = deferredList()
    listSessionsMock.mockReturnValueOnce(background.promise)
    await act(async () => changeAssociations())
    // The foreground answer was computed for the old associations, so it is not publishable.
    renders.length = 0
    await act(async () =>
      foreground.resolve({ ...EMPTY_RESULT, sessions: [session(1), session(2)] })
    )
    await flush()
    expect(ids()).toEqual(['session-1'])
    expect(latest?.loading).toBe(false)
    expect(latest?.refreshing).toBe(false)

    await act(async () =>
      background.resolve({ ...EMPTY_RESULT, sessions: [session(1), session(3)] })
    )
    await flush()
    expect(ids()).toEqual(['session-1', 'session-3'])
    expect(renders.some((render) => render.ids.includes('session-2'))).toBe(false)
    // The relaunched refresh is background: it never raises the flags.
    expect(renders.some((render) => render.refreshing || render.loading)).toBe(false)
  })

  it('keeps the flags through a held list that associations invalidate, until the background list lands', async () => {
    await mountWithRows()
    const foreground = deferredList()
    listSessionsMock.mockReturnValueOnce(foreground.promise)
    await act(async () => void latest?.refresh({ force: true }))
    markInputQuietSchedulerInput()
    await act(async () => foreground.resolve({ ...EMPTY_RESULT, sessions: [session(4)] }))
    await flush()
    expect(ids()).toEqual(['session-1'])
    expect(latest?.refreshing).toBe(true)

    const background = deferredList()
    listSessionsMock.mockReturnValueOnce(background.promise)
    renders.length = 0
    await act(async () => changeAssociations())
    await act(async () => {
      vi.advanceTimersByTime(1_000)
    })
    await flush()
    // The held list is cancelled, never shown; the outstanding flag waits for the replacement.
    expect(ids()).toEqual(['session-1'])
    expect(latest?.refreshing).toBe(true)

    await act(async () => background.resolve({ ...EMPTY_RESULT, sessions: [session(5)] }))
    await act(async () => {
      vi.advanceTimersByTime(1_000)
    })
    await flush()
    expect(ids()).toEqual(['session-5'])
    expect(latest?.loading).toBe(false)
    expect(latest?.refreshing).toBe(false)
    expect(renders.some((render) => render.ids.includes('session-4'))).toBe(false)
  })

  it('clears the flags and keeps the rows when the replacing background refresh fails', async () => {
    await mountWithRows()
    const foreground = deferredList()
    listSessionsMock.mockReturnValueOnce(foreground.promise)
    await act(async () => void latest?.refresh({ force: true }))
    markInputQuietSchedulerInput()
    await act(async () => foreground.resolve({ ...EMPTY_RESULT, sessions: [session(4)] }))
    await flush()

    const background = deferredList()
    listSessionsMock.mockReturnValueOnce(background.promise)
    await act(async () => changeAssociations())
    await act(async () => background.reject(new Error('host unavailable')))
    await flush()
    expect(ids()).toEqual(['session-1'])
    expect(latest?.loading).toBe(false)
    expect(latest?.refreshing).toBe(false)
  })
})
