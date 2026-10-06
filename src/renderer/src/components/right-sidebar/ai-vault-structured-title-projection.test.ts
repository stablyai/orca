// @vitest-environment happy-dom

import { act, createElement, Fragment } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AiVaultListResult } from '../../../../shared/ai-vault-types'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { Tab } from '../../../../shared/tab-types'
import { useAppStore } from '@/store'
import { AiVaultTabTitleSyncGate } from '../AiVaultTabTitleSyncGate'
import { DEFAULT_AI_VAULT_SESSION_LIMIT } from './ai-vault-session-limit'
import {
  resetAiVaultForcedRescanThrottleForTest,
  useAiVaultSessionRefresh
} from './ai-vault-session-refresh'
import {
  aiVaultSessionResultCacheKey,
  cacheAiVaultSessionResult,
  readCachedAiVaultSessionResult
} from './ai-vault-session-result-cache'
import { defaultAgentChatLabel } from '../../../../shared/agent-session-chat-label'
import { session, tab, result } from './ai-vault-structured-title-fixtures'
import {
  markInputQuietSchedulerInput,
  resetInputQuietSchedulerForTest
} from '@/lib/input-quiet-scheduler'

const initialState = useAppStore.getInitialState()
const listSessions = vi.fn<() => Promise<AiVaultListResult>>()
const cancelListSessions = vi.fn<() => Promise<void>>()
let focusWindow: (() => void) | undefined
let latest: ReturnType<typeof useAiVaultSessionRefresh> | undefined
let root: Root

function Probe({ host }: { host: ExecutionHostId }): null {
  latest = useAiVaultSessionRefresh(['/folder'], host, DEFAULT_AI_VAULT_SESSION_LIMIT)
  return null
}

async function render(visible = true, host: ExecutionHostId = 'local'): Promise<void> {
  await act(async () => {
    root.render(
      createElement(
        Fragment,
        null,
        createElement(AiVaultTabTitleSyncGate),
        visible ? createElement(Probe, { host }) : null
      )
    )
  })
}

async function setTabs(tabs: Tab[]): Promise<void> {
  await act(async () => {
    useAppStore.setState({ unifiedTabsByWorktree: { 'folder-workspace': tabs } })
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  useAppStore.setState(initialState, true)
  resetAiVaultForcedRescanThrottleForTest()
  resetInputQuietSchedulerForTest()
  listSessions.mockReset().mockResolvedValue(result())
  cancelListSessions.mockReset().mockResolvedValue()
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      aiVault: {
        listSessions,
        cancelListSessions,
        resolveSessionTitles: vi.fn().mockResolvedValue({ titles: [] }),
        onWindowFocused: (callback: () => void) => {
          focusWindow = callback
          return () => {
            focusWindow = undefined
          }
        }
      }
    }
  })
  const container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  document.body.replaceChildren()
  useAppStore.setState(initialState, true)
  vi.useRealTimers()
  vi.restoreAllMocks()
  latest = undefined
})

describe('native chat names in cached Vault rows', () => {
  it.each([
    { host: 'local', agent: 'codex' },
    { host: 'local', agent: 'claude' },
    { host: 'runtime:paired-host', agent: 'codex' },
    { host: 'runtime:paired-host', agent: 'claude' }
  ] as const)(
    'retains the generated name after closing a $host $agent folder chat without rescanning',
    async ({ host, agent }) => {
      listSessions.mockResolvedValue(result(session(host, agent)))
      await setTabs([tab(defaultAgentChatLabel(agent), host, agent)])
      await render(true, host)
      expect(latest?.sessions[0]?.title).toBe(defaultAgentChatLabel(agent))

      await setTabs([{ ...tab('Explain the parser', host, agent), customLabel: 'My manual name' }])
      expect(latest?.sessions[0]?.title).toBe('Explain the parser')
      await setTabs([])
      expect(latest?.sessions[0]?.title).toBe('Explain the parser')
      expect(listSessions).toHaveBeenCalledTimes(1)
    }
  )

  it('updates the existing cache while the panel is unmounted and preserves it after close', async () => {
    await setTabs([tab()])
    await render()
    await render(false)
    await setTabs([tab('Find the race')])
    await setTabs([])
    await render()
    expect(latest?.sessions[0]?.title).toBe('Find the race')
    expect(listSessions).toHaveBeenCalledTimes(1)
  })

  it('accepts a host-projected name with the same scanner stamp and reuses it on remount', async () => {
    await render()
    listSessions.mockResolvedValueOnce(result({ ...session(), title: 'Saved while disconnected' }))
    await act(async () => {
      focusWindow?.()
    })
    expect(latest?.sessions[0]?.title).toBe('Saved while disconnected')
    await render(false)
    await render()
    expect(latest?.sessions[0]?.title).toBe('Saved while disconnected')
    expect(listSessions).toHaveBeenCalledTimes(2)
  })

  it('does not copy a colliding session from another execution host', async () => {
    await render()
    await setTabs([tab('Other host title', 'runtime:other-host')])
    expect(latest?.sessions[0]?.title).toBe('Codex Chat')
    expect(listSessions).toHaveBeenCalledTimes(1)
  })

  it('does not copy a colliding session from another provider or workspace', async () => {
    await render()
    await setTabs([tab('Other provider title', 'local', 'claude')])
    expect(latest?.sessions[0]?.title).toBe('Codex Chat')
    await act(async () => {
      useAppStore.setState({
        unifiedTabsByWorktree: { 'another-workspace': [tab('Other workspace title')] }
      })
    })
    expect(latest?.sessions[0]?.title).toBe('Codex Chat')
  })

  it('does not replace a host-projected name with a provisional tab placeholder', async () => {
    listSessions.mockResolvedValue(result({ ...session(), title: 'Saved host name' }))
    await setTabs([tab()])
    await render()
    await setTabs([])
    expect(latest?.sessions[0]?.title).toBe('Saved host name')
  })

  it('updates a mounted scan after its renderer cache entry was evicted', async () => {
    await setTabs([tab()])
    await render()
    for (let index = 0; index < 8; index++) {
      cacheAiVaultSessionResult({
        key: aiVaultSessionResultCacheKey('local', [`/other-folder-${index}`]),
        executionHostScope: 'local',
        limit: DEFAULT_AI_VAULT_SESSION_LIMIT,
        result: { ...result(), sessions: [] },
        replaceHostEntries: false
      })
    }
    await setTabs([tab('Name after eviction')])
    await setTabs([])
    expect(latest?.sessions[0]?.title).toBe('Name after eviction')
    expect(listSessions).toHaveBeenCalledTimes(1)
  })

  it('keeps a generated name when an earlier Vault request resolves after the chat closes', async () => {
    await setTabs([tab()])
    await render()
    let resolveScan: ((value: AiVaultListResult) => void) | undefined
    listSessions.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveScan = resolve
      })
    )
    await act(async () => {
      focusWindow?.()
    })
    await setTabs([tab('Named during scan')])
    await setTabs([])
    await act(async () => {
      resolveScan?.({ ...result(), scannedAt: '2026-10-06T00:00:01Z' })
    })
    expect(latest?.sessions[0]?.title).toBe('Named during scan')
    listSessions.mockResolvedValueOnce(result({ ...session(), title: 'Later host value' }))
    await act(async () => {
      focusWindow?.()
    })
    expect(latest?.sessions[0]?.title).toBe('Later host value')
  })

  it('retains a name generated before input-quiet publication even if the chat closes first', async () => {
    await setTabs([tab()])
    markInputQuietSchedulerInput()
    await render()
    expect(latest?.scanResult).toBeNull()
    await setTabs([tab('Named before publication')])
    await setTabs([])
    await act(async () => {
      vi.advanceTimersByTime(101)
    })
    expect(latest?.sessions[0]?.title).toBe('Named before publication')
    expect(listSessions).toHaveBeenCalledTimes(1)
  })

  it.each([
    { executionHostId: 'runtime:other-host' },
    { agent: 'claude' },
    { sessionId: 'another-provider-session' },
    { structuredSession: { workspaceId: 'another-folder', sessionId: 'native-session' } },
    { structuredSession: { workspaceId: 'folder-workspace', sessionId: 'replacement-session' } }
  ] as const)(
    'does not carry an in-flight name into a different structured owner: %j',
    async (replacement) => {
      await setTabs([tab()])
      await render()
      let resolveScan: ((value: AiVaultListResult) => void) | undefined
      listSessions.mockReturnValueOnce(
        new Promise((resolve) => {
          resolveScan = resolve
        })
      )
      await act(async () => {
        focusWindow?.()
      })
      await setTabs([tab('Old ownership name')])
      await setTabs([])
      await act(async () => {
        resolveScan?.({
          ...result({ ...session(), ...replacement, title: 'Different owner name' }),
          scannedAt: '2026-10-06T00:00:01Z'
        })
      })
      expect(latest?.sessions[0]?.title).toBe('Different owner name')
    }
  )

  it('repairs name metadata in a deeper cache without dropping its older rows or previews', () => {
    const key = aiVaultSessionResultCacheKey('local', ['/folder'])
    const first = {
      ...session(),
      previewMessages: [{ role: 'user' as const, text: 'Opening prompt', timestamp: null }]
    }
    const older = { ...session(), id: 'older-session', structuredSession: undefined }
    cacheAiVaultSessionResult({
      key,
      executionHostScope: 'local',
      limit: 'unlimited',
      result: { ...result(first), sessions: [first, older] },
      replaceHostEntries: false
    })
    cacheAiVaultSessionResult({
      key,
      executionHostScope: 'local',
      limit: DEFAULT_AI_VAULT_SESSION_LIMIT,
      result: result({ ...session(), title: 'New projected name' }),
      replaceHostEntries: false
    })
    const cached = readCachedAiVaultSessionResult({
      key,
      limit: 'unlimited',
      scopePaths: ['/folder']
    })
    expect(cached?.sessions).toHaveLength(2)
    expect(cached?.sessions[0]?.title).toBe('New projected name')
    expect(cached?.sessions[0]?.previewMessages).toBe(first.previewMessages)
    expect(cached?.sessions[1]).toBe(older)
  })

  it('does not revisit cached Vault rows when only a terminal or manual label changes', async () => {
    await setTabs([tab('Stable generated name')])
    await render()
    const readCachedRow = vi.fn(() => ({
      workspaceId: 'folder-workspace',
      sessionId: 'native-session'
    }))
    const cached = latest?.scanResult
    if (!cached) {
      throw new Error('Expected an applied Vault result')
    }
    Object.defineProperty(cached.sessions[0], 'structuredSession', {
      get: readCachedRow,
      enumerable: true
    })
    const terminal: Tab = {
      ...tab(),
      id: 'terminal-tab',
      entityId: 'terminal',
      contentType: 'terminal',
      agentSessionAgent: undefined
    }
    await setTabs([{ ...tab('Stable generated name'), customLabel: 'Manual only' }, terminal])
    await setTabs([tab('Stable generated name')])
    expect(readCachedRow).not.toHaveBeenCalled()
    expect(listSessions).toHaveBeenCalledTimes(1)
  })

  it('does not inspect tab labels or scan transcripts on unrelated store writes', async () => {
    const live = tab()
    const readLabel = vi.fn(() => 'Codex Chat')
    Object.defineProperty(live, 'label', { get: readLabel, enumerable: true })
    await setTabs([live])
    await render()
    readLabel.mockClear()
    await act(async () => {
      for (let index = 1; index <= 20; index++) {
        useAppStore.setState({ sshConnectedGeneration: index })
      }
    })
    expect(readLabel).not.toHaveBeenCalled()
    expect(listSessions).toHaveBeenCalledTimes(1)
  })
})
