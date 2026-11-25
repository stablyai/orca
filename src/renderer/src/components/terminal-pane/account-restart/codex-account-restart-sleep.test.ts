import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SleepingAgentSessionRecord } from '../../../../../shared/agent-session/lifecycle/agent-session-resume'

const TAB = '11111111-1111-4111-8111-111111111111'
const LEAF = '22222222-2222-4222-8222-222222222222'
const PANE_KEY = `${TAB}:${LEAF}`

type SleepStore = {
  sleepingAgentSessionsByPaneKey: Record<string, SleepingAgentSessionRecord>
  ptyIdsByTabId: Record<string, string[]>
  rememberSleepingAgentSession: (
    record: SleepingAgentSessionRecord,
    replaces?: SleepingAgentSessionRecord
  ) => void
  clearSleepingAgentSession: (paneKey: string) => void
}

const { store, captured } = vi.hoisted(() => {
  const store: SleepStore = {
    sleepingAgentSessionsByPaneKey: {},
    ptyIdsByTabId: {},
    rememberSleepingAgentSession: (record, replaces) => {
      if (store.sleepingAgentSessionsByPaneKey[record.paneKey] === replaces) {
        store.sleepingAgentSessionsByPaneKey = {
          ...store.sleepingAgentSessionsByPaneKey,
          [record.paneKey]: record
        }
      }
    },
    clearSleepingAgentSession: (paneKey) => {
      const { [paneKey]: _removed, ...rest } = store.sleepingAgentSessionsByPaneKey
      store.sleepingAgentSessionsByPaneKey = rest
    }
  }
  const modes: string[] = []
  return { store, captured: { modes } }
})
vi.mock('@/store/index', () => ({ useAppStore: { getState: () => store } }))

function record(state: string): SleepingAgentSessionRecord {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only the identity fields are read here.
  return {
    paneKey: PANE_KEY,
    worktreeId: 'wt',
    agent: 'codex',
    state,
    providerSession: { key: 'session_id', id: 'thread-1' },
    origin: 'worktree-sleep'
  } as unknown as SleepingAgentSessionRecord
}
let capture: (mode: string) => SleepingAgentSessionRecord | undefined = () => record('done')
vi.mock('@/store/slices/agent-status/sleep-recovery/agent-status-recovery-collection', () => ({
  collectSleepingAgentSessionRecordsForWorktree: (
    _state: unknown,
    _worktreeId: string,
    options: { paneKeys: string[]; captureMode: string }
  ) => {
    captured.modes.push(options.captureMode)
    const found = capture(options.captureMode)
    return found ? { [options.paneKeys[0]!]: found } : {}
  }
}))

import { sleepPaneForAccountRestart } from './codex-account-restart-sleep'

const pane = { worktreeId: 'wt', tabId: TAB, leafId: LEAF, ptyId: 'pty-a' }

describe('account restart sleeps the pane before stopping it', () => {
  beforeEach(() => {
    store.sleepingAgentSessionsByPaneKey = {}
    store.ptyIdsByTabId = { [TAB]: ['pty-a'] }
    captured.modes = []
    capture = () => record('done')
  })

  it('writes the pane resume record before the stop, so the wake still has it after the exit', () => {
    const undo = sleepPaneForAccountRestart(pane)
    expect(store.sleepingAgentSessionsByPaneKey[PANE_KEY]).toMatchObject({
      origin: 'worktree-sleep',
      providerSession: { id: 'thread-1' }
    })
    // The exit retires the live row; the stopped process left the pane.
    store.ptyIdsByTabId = { [TAB]: [] }
    undo?.(true)
    expect(store.sleepingAgentSessionsByPaneKey[PANE_KEY]).toBeDefined()
  })

  it('sleeps a running turn as a manual sleep when it is not a finished one', () => {
    capture = (mode) => (mode === 'manual-worktree-sleep' ? record('working') : undefined)
    sleepPaneForAccountRestart(pane)
    expect(captured.modes).toEqual(['completed-agent-hibernation', 'manual-worktree-sleep'])
    expect(store.sleepingAgentSessionsByPaneKey[PANE_KEY]?.state).toBe('working')
  })

  it('puts the earlier record back when the stop never ended the process', () => {
    const earlier = { ...record('done'), origin: 'live' as const }
    store.sleepingAgentSessionsByPaneKey = { [PANE_KEY]: earlier }
    const undo = sleepPaneForAccountRestart(pane)
    expect(store.sleepingAgentSessionsByPaneKey[PANE_KEY]).not.toBe(earlier)
    undo?.(false)
    expect(store.sleepingAgentSessionsByPaneKey[PANE_KEY]).toBe(earlier)
  })

  it('removes the record when the stop never ran and none existed before', () => {
    const undo = sleepPaneForAccountRestart(pane)
    undo?.(false)
    expect(store.sleepingAgentSessionsByPaneKey[PANE_KEY]).toBeUndefined()
  })

  it('keeps the record after an unknown stop whose process is already gone', () => {
    const undo = sleepPaneForAccountRestart(pane)
    store.ptyIdsByTabId = { [TAB]: [] }
    undo?.(false)
    expect(store.sleepingAgentSessionsByPaneKey[PANE_KEY]).toBeDefined()
  })

  it('records nothing for a pane with no resumable conversation', () => {
    capture = () => undefined
    expect(sleepPaneForAccountRestart(pane)).toBeNull()
    expect(store.sleepingAgentSessionsByPaneKey).toEqual({})
  })
})
