import { useAppStore } from '@/store'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'

export const LEAF_ID = '11111111-1111-4111-8111-111111111111'
export const OTHER_LEAF_ID = '22222222-2222-4222-8222-222222222222'

export function makeRecord(
  overrides: Partial<SleepingAgentSessionRecord> = {}
): SleepingAgentSessionRecord {
  return {
    paneKey: 'tab-1:leaf-1',
    tabId: 'tab-1',
    worktreeId: 'wt-1',
    agent: 'claude',
    providerSession: { key: 'session_id', id: 'sess-1' },
    prompt: 'finish the task',
    state: 'working',
    capturedAt: 1,
    updatedAt: 1,
    ...overrides
  }
}

export function makeTerminalTab(id: string, worktreeId: string): Record<string, unknown> {
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

export function makeLayout(leafId: string, ptyId = 'pty-1'): Record<string, unknown> {
  return {
    root: { type: 'leaf', leafId },
    activeLeafId: leafId,
    expandedLeafId: null,
    ptyIdsByLeafId: { [leafId]: ptyId }
  }
}

export function makeSplitLayout(
  leafId: string,
  otherLeafId: string,
  ptyIdsByLeafId: Record<string, string>
): Record<string, unknown> {
  return {
    root: {
      type: 'split',
      direction: 'horizontal',
      first: { type: 'leaf', leafId },
      second: { type: 'leaf', leafId: otherLeafId },
      ratio: 0.5
    },
    activeLeafId: leafId,
    expandedLeafId: null,
    ptyIdsByLeafId
  }
}

/** Spends every queued startup — the spawn-success signal that clears each
 *  resume startup's sleeping record. */
export function consumeQueuedResumeStartups(): void {
  const state = useAppStore.getState()
  for (const tabId of Object.keys(state.pendingStartupByTabId)) {
    state.consumeTabStartupCommand(tabId)
  }
}

export function makeActiveTerminalState(
  tabId: string,
  worktreeId = 'wt-1'
): Record<string, unknown> {
  return {
    activeWorktreeId: worktreeId,
    activeTabType: 'terminal',
    activeTabId: tabId,
    activeTabIdByWorktree: { [worktreeId]: tabId }
  }
}
