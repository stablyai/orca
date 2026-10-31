import { describe, expect, it } from 'vitest'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'

function note(overrides: Partial<SleepingAgentSessionRecord> = {}): SleepingAgentSessionRecord {
  return {
    paneKey: 'tab-1:leaf-1',
    worktreeId: 'wt-1',
    agent: 'codex',
    providerSession: { key: 'session_id', id: 'conv-1' },
    prompt: '',
    state: 'done',
    capturedAt: 1,
    updatedAt: 1,
    ...overrides
  }
}

describe('recordPaneIsOwnedByPreservedPane: a pane its host kept asleep', () => {
  const layout = {
    'tab-1': {
      root: { type: 'leaf' as const, leafId: '11111111-1111-4111-8111-111111111111' },
      activeLeafId: '11111111-1111-4111-8111-111111111111',
      expandedLeafId: null
    }
  }
  const paneKey = 'tab-1:11111111-1111-4111-8111-111111111111'
  const state = {
    activeWorktreeId: 'wt-other',
    tabsByWorktree: { 'wt-1': [{ id: 'tab-1' }] },
    ptyIdsByTabId: {},
    terminalLayoutsByTabId: layout
  }

  it('owns its unfinished session while deferred, so a sweep does not launch it again', async () => {
    const { setPaneSpawnDeferral, clearPaneSpawnDeferral } =
      await import('./pane-spawn-deferral-registry')
    const { recordPaneIsOwnedByPreservedPane } = await import('./sleeping-agent-pane-ownership')
    const record = note({ paneKey, tabId: 'tab-1', origin: 'quit' })

    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the predicate reads only these four store maps.
    expect(recordPaneIsOwnedByPreservedPane(record, state as never)).toBe(false)
    setPaneSpawnDeferral(paneKey, { reason: 'live_cap', resume: () => {} })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the predicate reads only these four store maps.
    expect(recordPaneIsOwnedByPreservedPane(record, state as never)).toBe(true)
    clearPaneSpawnDeferral(paneKey)
  })

  it('owns a legacy-keyed session while its pane holds the resume until shown', async () => {
    const { holdPaneResumeUntilShown, releasePaneResumeHold } =
      await import('./pane-spawn-deferral-registry')
    const { recordPaneIsOwnedByPreservedPane } = await import('./sleeping-agent-pane-ownership')
    const record = note({ paneKey: 'tab-1:2', tabId: 'tab-1', origin: 'quit' })
    const holding = (): boolean => true
    const legacyState = { ...state, sleepingAgentSessionsByPaneKey: { 'tab-1:2': record } }

    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the predicate reads only these five store maps.
    expect(recordPaneIsOwnedByPreservedPane(record, legacyState as never)).toBe(false)
    holdPaneResumeUntilShown('tab-1:2', holding)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the predicate reads only these five store maps.
    expect(recordPaneIsOwnedByPreservedPane(record, legacyState as never)).toBe(true)
    releasePaneResumeHold('tab-1:2', holding)
  })

  it('owns its record while the dispatcher promised the pane a wake on mount', async () => {
    const { recordPaneIsOwnedByPreservedPane } = await import('./sleeping-agent-pane-ownership')
    const { markSleepingAgentWakeRequest, takeSleepingAgentWakeRequest } =
      await import('./sleeping-agent-wake-request-registry')
    const record = note({ paneKey, tabId: 'tab-1', origin: 'quit' })

    // Dead PTY, inactive worktree: unowned before the promise, owned while the pane owes a wake.
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the predicate reads only these four store maps.
    expect(recordPaneIsOwnedByPreservedPane(record, state as never)).toBe(false)
    markSleepingAgentWakeRequest(record)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the predicate reads only these four store maps.
    expect(recordPaneIsOwnedByPreservedPane(record, state as never)).toBe(true)
    // Consuming the wake at pane mount releases ownership, so a sweep after a dead pane cannot strand the record.
    takeSleepingAgentWakeRequest(record)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the predicate reads only these four store maps.
    expect(recordPaneIsOwnedByPreservedPane(record, state as never)).toBe(false)
  })
})
