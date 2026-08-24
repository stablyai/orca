import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'
import { AGENT_STATUS_STALE_AFTER_MS } from '../../../shared/agent-status-types'
import { makePaneKey } from '../../../shared/stable-pane-id'
import { useAppStore } from '@/store'
import { resumeSleepingAgentSessionsForWorktree } from './resume-sleeping-agent-session'

const initialAppStoreState = useAppStore.getState()
const LEAF_ID = '55555555-5555-4555-8555-555555555555'
const STALE_UPDATED_AT = 1
const STALE_CAPTURED_AT = STALE_UPDATED_AT + AGENT_STATUS_STALE_AFTER_MS + 1

afterEach(() => {
  vi.unstubAllGlobals()
  useAppStore.setState(initialAppStoreState, true)
})

function makeRecord(
  overrides: Partial<SleepingAgentSessionRecord> = {}
): SleepingAgentSessionRecord {
  return {
    paneKey: 'tab-1:leaf-1',
    tabId: 'tab-1',
    worktreeId: 'wt-1',
    agent: 'claude',
    providerSession: { key: 'session_id', id: 'sess-stale' },
    prompt: 'finish the task',
    state: 'working',
    capturedAt: STALE_CAPTURED_AT,
    updatedAt: STALE_UPDATED_AT,
    origin: 'worktree-sleep',
    ...overrides
  }
}

function makeTerminalTab(id: string, worktreeId: string): Record<string, unknown> {
  return {
    id,
    ptyId: null,
    worktreeId,
    title: 'shell',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1
  }
}

function makeLayout(leafId: string, ptyId = 'pty-1'): Record<string, unknown> {
  return {
    root: { type: 'leaf', leafId },
    activeLeafId: leafId,
    expandedLeafId: null,
    ptyIdsByLeafId: { [leafId]: ptyId }
  }
}

describe('resumeSleepingAgentSessionsForWorktree stale recovery', () => {
  // Why: a quiet-past-freshness Claude session is unverifiable, not dead. Wake must still
  // launch `claude --resume` when the provider session id is recoverable (STA-2844).
  it('launches claude --resume for a working record that was already stale at capture', () => {
    const record = makeRecord({ origin: 'live' })
    useAppStore.setState({
      tabsByWorktree: { 'wt-1': [] },
      sleepingAgentSessionsByPaneKey: { [record.paneKey]: record }
    } as never)

    const launched = resumeSleepingAgentSessionsForWorktree('wt-1')

    const state = useAppStore.getState()
    const resumedTab = state.tabsByWorktree['wt-1']?.[0]
    expect(launched).toBe(1)
    expect(resumedTab?.launchAgent).toBe('claude')
    expect(state.pendingStartupByTabId[resumedTab!.id]?.command).toContain('--resume')
    expect(state.pendingStartupByTabId[resumedTab!.id]?.command).toContain('sess-stale')
    expect(state.sleepingAgentSessionsByPaneKey[record.paneKey]).toBeUndefined()
  })

  // Why: manual sleep preserves the pane husk; activation must leave the stale record for
  // in-place cold restore instead of clearing it as expired (STA-2844).
  it('keeps a stale worktree-sleep record on a preserved pane for in-place resume', () => {
    const paneKey = makePaneKey('tab-1', LEAF_ID)
    const record = makeRecord({ paneKey, origin: 'worktree-sleep' })
    useAppStore.setState({
      activeWorktreeId: 'wt-1',
      activeTabType: 'terminal',
      activeTabId: 'tab-1',
      activeTabIdByWorktree: { 'wt-1': 'tab-1' },
      tabsByWorktree: { 'wt-1': [makeTerminalTab('tab-1', 'wt-1')] },
      terminalLayoutsByTabId: { 'tab-1': makeLayout(LEAF_ID) },
      sleepingAgentSessionsByPaneKey: { [record.paneKey]: record }
    } as never)

    const launched = resumeSleepingAgentSessionsForWorktree('wt-1')

    const state = useAppStore.getState()
    expect(launched).toBe(0)
    expect(state.tabsByWorktree['wt-1']).toHaveLength(1)
    expect(state.sleepingAgentSessionsByPaneKey[record.paneKey]).toBe(record)
  })

  it('does not fabricate a resume for an unresumable Pi checkpoint without a transcript', () => {
    const record = makeRecord({
      agent: 'pi',
      providerSession: { key: 'session_id', id: 'pi-session-1' }
    })
    useAppStore.setState({
      tabsByWorktree: { 'wt-1': [] },
      sleepingAgentSessionsByPaneKey: { [record.paneKey]: record }
    } as never)

    const launched = resumeSleepingAgentSessionsForWorktree('wt-1')

    expect(launched).toBe(0)
    expect(useAppStore.getState().tabsByWorktree['wt-1']).toEqual([])
    expect(useAppStore.getState().sleepingAgentSessionsByPaneKey[record.paneKey]).toBeUndefined()
  })
})
