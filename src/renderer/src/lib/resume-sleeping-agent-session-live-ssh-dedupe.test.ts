import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'
import { makePaneKey } from '../../../shared/stable-pane-id'
import { useAppStore } from '@/store'
import { resumeSleepingAgentSessionsForWorktree } from './resume-sleeping-agent-session'

const initialAppStoreState = useAppStore.getState()
const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const OTHER_LEAF_ID = '22222222-2222-4222-8222-222222222222'
const SSH_PTY_ID = 'ssh:ssh-target-1@@pty-3'

afterEach(() => {
  vi.unstubAllGlobals()
  useAppStore.setState(initialAppStoreState, true)
})

function makeRecord(
  overrides: Partial<SleepingAgentSessionRecord> = {}
): SleepingAgentSessionRecord {
  return {
    paneKey: makePaneKey('tab-1', LEAF_ID),
    tabId: 'tab-1',
    worktreeId: 'wt-1',
    agent: 'claude',
    providerSession: { key: 'session_id', id: 'sess-1' },
    prompt: 'finish the task',
    state: 'working',
    origin: 'quit',
    capturedAt: 1,
    updatedAt: 1,
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

function makeLayout(leafId: string, ptyId: string | null): Record<string, unknown> {
  return {
    root: { type: 'leaf', leafId },
    activeLeafId: leafId,
    expandedLeafId: null,
    ptyIdsByLeafId: ptyId ? { [leafId]: ptyId } : {}
  }
}

describe('resumeSleepingAgentSessionsForWorktree — SSH relay panes and stale worktree ids', () => {
  it('treats a leaf bound to an ssh relay pty as pane-owned while its target is disconnected', () => {
    const record = makeRecord()
    useAppStore.setState({
      activeWorktreeId: 'wt-other',
      tabsByWorktree: { 'wt-1': [makeTerminalTab('tab-1', 'wt-1')] },
      terminalLayoutsByTabId: { 'tab-1': makeLayout(LEAF_ID, SSH_PTY_ID) },
      ptyIdsByTabId: {},
      sleepingAgentSessionsByPaneKey: { [record.paneKey]: record }
    } as never)

    const launched = resumeSleepingAgentSessionsForWorktree('wt-1')

    expect(launched).toBe(0)
    expect(useAppStore.getState().sleepingAgentSessionsByPaneKey[record.paneKey]).toBe(record)
  })

  it('still resumes when the preserved pane has no pty binding and cannot own recovery', () => {
    const record = makeRecord()
    useAppStore.setState({
      activeWorktreeId: 'wt-other',
      tabsByWorktree: { 'wt-1': [makeTerminalTab('tab-1', 'wt-1')] },
      terminalLayoutsByTabId: { 'tab-1': makeLayout(LEAF_ID, null) },
      ptyIdsByTabId: {},
      sleepingAgentSessionsByPaneKey: { [record.paneKey]: record }
    } as never)

    const launched = resumeSleepingAgentSessionsForWorktree('wt-1')

    expect(launched).toBe(1)
  })

  it('finds the preserved tab when the record worktreeId is stale', () => {
    const record = makeRecord()
    useAppStore.setState({
      activeWorktreeId: 'wt-other',
      tabsByWorktree: { 'wt-1': [], 'wt-2': [makeTerminalTab('tab-1', 'wt-2')] },
      terminalLayoutsByTabId: { 'tab-1': makeLayout(LEAF_ID, SSH_PTY_ID) },
      ptyIdsByTabId: {},
      sleepingAgentSessionsByPaneKey: { [record.paneKey]: record }
    } as never)

    const launched = resumeSleepingAgentSessionsForWorktree('wt-1')

    expect(launched).toBe(0)
    expect(useAppStore.getState().sleepingAgentSessionsByPaneKey[record.paneKey]).toBe(record)
  })

  it('clears a record whose provider session is owned by a record in another worktree', () => {
    const stale = makeRecord({ providerSession: { key: 'session_id', id: 'sess-9' } })
    const owned = makeRecord({
      paneKey: makePaneKey('tab-2', OTHER_LEAF_ID),
      tabId: 'tab-2',
      worktreeId: 'wt-2',
      providerSession: { key: 'session_id', id: 'sess-9' }
    })
    useAppStore.setState({
      activeWorktreeId: 'wt-other',
      tabsByWorktree: { 'wt-1': [], 'wt-2': [makeTerminalTab('tab-2', 'wt-2')] },
      terminalLayoutsByTabId: { 'tab-2': makeLayout(OTHER_LEAF_ID, SSH_PTY_ID) },
      ptyIdsByTabId: {},
      sleepingAgentSessionsByPaneKey: { [stale.paneKey]: stale, [owned.paneKey]: owned }
    } as never)

    const launched = resumeSleepingAgentSessionsForWorktree('wt-1')

    expect(launched).toBe(0)
    const records = useAppStore.getState().sleepingAgentSessionsByPaneKey
    expect(records[stale.paneKey]).toBeUndefined()
    expect(records[owned.paneKey]).toBe(owned)
  })
})
