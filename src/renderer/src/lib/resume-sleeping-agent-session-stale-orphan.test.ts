import { afterEach, describe, expect, it } from 'vitest'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'
import { AGENT_STATUS_STALE_AFTER_MS } from '../../../shared/agent-status-types'
import { makePaneKey } from '../../../shared/stable-pane-id'
import { structuredAgentSessionTabId } from '../../../shared/structured-agent-session-projection'
import type { TerminalTab } from '../../../shared/terminal-tab-types'
import { useAppStore } from '@/store'
import { resumeSleepingAgentSessionsForWorktree } from './resume-sleeping-agent-session'
import { getProviderSessionClaimKey } from './sleeping-agent-pane-ownership'

const initialAppStoreState = useAppStore.getState()

afterEach(() => {
  useAppStore.setState(initialAppStoreState, true)
})

const STALE_CAPTURED_AT = AGENT_STATUS_STALE_AFTER_MS + 60_000
const LEAF_ID = '11111111-1111-4111-8111-111111111111'

function makeRecord(
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
    origin: 'quit',
    capturedAt: 1,
    updatedAt: 1,
    ...overrides
  }
}

function makeTerminalTab(id: string, worktreeId: string): TerminalTab {
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

function seed(records: SleepingAgentSessionRecord[], tabIds: string[]): void {
  useAppStore.setState({
    activeWorktreeId: 'wt-other',
    activeTabId: 'other-tab',
    activeTabType: 'browser',
    activeTabIdByWorktree: { 'wt-other': 'other-tab' },
    tabsByWorktree: { 'wt-1': tabIds.map((id) => makeTerminalTab(id, 'wt-1')) },
    sleepingAgentSessionsByPaneKey: Object.fromEntries(records.map((r) => [r.paneKey, r]))
  })
}

describe('resumeSleepingAgentSessionsForWorktree stale records under a skipped claim', () => {
  it('clears a stale record whose tab is gone even when its claim is skipped', () => {
    // Regression (#23391): the same provider session is live in another tab, so its claim key is
    // skipped; the stale duplicate for the vanished tab used to be skipped too and never cleared.
    const orphan = makeRecord({
      paneKey: 'tab-gone:leaf-1',
      tabId: 'tab-gone',
      capturedAt: STALE_CAPTURED_AT
    })
    seed([orphan], ['tab-live'])

    const launched = resumeSleepingAgentSessionsForWorktree('wt-1', {
      suppressNavigation: true,
      skipClaimKeys: new Set([getProviderSessionClaimKey(orphan)])
    })

    expect(launched).toBe(0)
    const state = useAppStore.getState()
    expect(state.sleepingAgentSessionsByPaneKey[orphan.paneKey]).toBeUndefined()
    expect(state.tabsByWorktree['wt-1']?.map((tab) => tab.id)).toEqual(['tab-live'])
  })

  it('keeps a stale record under a skipped claim while its tab still exists', () => {
    // The mounted pane that consumed the in-place wake owns this record until its spawn lands.
    const record = makeRecord({ capturedAt: STALE_CAPTURED_AT })
    seed([record], ['tab-1'])

    const launched = resumeSleepingAgentSessionsForWorktree('wt-1', {
      suppressNavigation: true,
      skipClaimKeys: new Set([getProviderSessionClaimKey(record)])
    })

    expect(launched).toBe(0)
    expect(useAppStore.getState().sleepingAgentSessionsByPaneKey[record.paneKey]).toBe(record)
  })

  it('keeps a fresh tab-less record under a skipped claim', () => {
    const record = makeRecord({ paneKey: 'tab-gone:leaf-1', tabId: 'tab-gone' })
    seed([record], ['tab-live'])

    const launched = resumeSleepingAgentSessionsForWorktree('wt-1', {
      suppressNavigation: true,
      skipClaimKeys: new Set([getProviderSessionClaimKey(record)])
    })

    expect(launched).toBe(0)
    expect(useAppStore.getState().sleepingAgentSessionsByPaneKey[record.paneKey]).toBe(record)
  })

  it('keeps a structured session record whose skipped claim is owned natively', () => {
    // A structured session's synthetic tab never exists among terminal tabs; the native-ownership
    // skip must still protect it.
    const tabId = structuredAgentSessionTabId('sess-native')
    const record = makeRecord({
      paneKey: makePaneKey(tabId, LEAF_ID),
      tabId,
      agent: 'codex',
      providerSession: { key: 'session_id', id: 'sess-native' },
      origin: undefined
    })
    seed([record], [])

    const launched = resumeSleepingAgentSessionsForWorktree('wt-1', {
      suppressNavigation: true,
      skipClaimKeys: new Set([getProviderSessionClaimKey(record)])
    })

    expect(launched).toBe(0)
    expect(useAppStore.getState().sleepingAgentSessionsByPaneKey[record.paneKey]).toBe(record)
  })

  it('keeps a stale record when its pane-key tab exists but record.tabId drifted', () => {
    const record = makeRecord({
      paneKey: makePaneKey('tab-live', LEAF_ID),
      tabId: 'tab-drifted',
      capturedAt: STALE_CAPTURED_AT
    })
    seed([record], ['tab-live'])

    const launched = resumeSleepingAgentSessionsForWorktree('wt-1', {
      suppressNavigation: true,
      skipClaimKeys: new Set([getProviderSessionClaimKey(record)])
    })

    expect(launched).toBe(0)
    expect(useAppStore.getState().sleepingAgentSessionsByPaneKey[record.paneKey]).toBe(record)
  })

  it('keeps a stale record under a skipped claim when its tab was re-homed to another worktree', () => {
    // The live-PTY claim follows the tab id, not the worktree, so the pane still owns the record.
    const record = makeRecord({ capturedAt: STALE_CAPTURED_AT })
    seed([record], [])
    useAppStore.setState({ tabsByWorktree: { 'wt-2': [makeTerminalTab('tab-1', 'wt-2')] } })

    const launched = resumeSleepingAgentSessionsForWorktree('wt-1', {
      suppressNavigation: true,
      skipClaimKeys: new Set([getProviderSessionClaimKey(record)])
    })

    expect(launched).toBe(0)
    expect(useAppStore.getState().sleepingAgentSessionsByPaneKey[record.paneKey]).toBe(record)
  })
})
