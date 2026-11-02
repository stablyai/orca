// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AiVaultListResult, AiVaultSession } from '../../../../shared/ai-vault-types'
import type { ExecutionHostScope } from '../../../../shared/execution-host'
import { useAppStore } from '@/store'
import {
  resetAiVaultForcedRescanThrottleForTest,
  useAiVaultSessionRefresh
} from './ai-vault-session-refresh'

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

function Probe({
  host,
  limit,
  paths
}: {
  host: ExecutionHostScope
  limit: number
  paths: readonly string[]
}): null {
  latest = useAiVaultSessionRefresh(paths, host, limit)
  return null
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
  root = createRoot(document.createElement('div'))
})
afterEach(() => {
  act(() => root?.unmount())
  root = null
  latest = null
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
