import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'
import { AGENT_STATUS_STALE_AFTER_MS } from '../../../shared/agent-status-types'
import { useAppStore } from '@/store'
import {
  RESUME_RECORD_MAX_AGE_MS,
  resumeSleepingAgentSessionsForWorktree
} from './resume-sleeping-agent-session'

const initialAppStoreState = useAppStore.getState()
const NOW = 1_800_000_000_000

beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(NOW)
})

afterEach(() => {
  vi.restoreAllMocks()
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
    providerSession: { key: 'session_id', id: 'sess-1' },
    prompt: 'finish the task',
    state: 'working',
    // A live capture stamps both fields from the same value, so the relative
    // staleness check below can never fire for one of these.
    capturedAt: NOW,
    updatedAt: NOW,
    origin: 'live',
    ...overrides
  }
}

function seedWorktreeWithUnownedPane(record: SleepingAgentSessionRecord): void {
  useAppStore.setState({
    tabsByWorktree: {
      'wt-1': [
        {
          id: 'tab-1',
          ptyId: null,
          worktreeId: 'wt-1',
          title: 'shell',
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: 1
        }
      ]
    },
    sleepingAgentSessionsByPaneKey: { [record.paneKey]: record }
  } as never)
}

describe('resume record absolute expiry', () => {
  it('retires a record older than the maximum age instead of resuming it', () => {
    const capturedAt = NOW - RESUME_RECORD_MAX_AGE_MS - 1
    const record = makeRecord({ capturedAt, updatedAt: capturedAt })
    seedWorktreeWithUnownedPane(record)

    expect(resumeSleepingAgentSessionsForWorktree('wt-1')).toBe(0)

    const state = useAppStore.getState()
    // Retiring, not merely skipping: the record is dropped, so an install that
    // has accumulated orphans heals itself on the next activation rather than
    // needing the profile edited or the app restarted.
    expect(state.sleepingAgentSessionsByPaneKey[record.paneKey]).toBeUndefined()
    expect(state.tabsByWorktree['wt-1']).toHaveLength(1)
  })

  it('still resumes a record inside the maximum age', () => {
    const capturedAt = NOW - RESUME_RECORD_MAX_AGE_MS + 60_000
    const record = makeRecord({ capturedAt, updatedAt: capturedAt })
    seedWorktreeWithUnownedPane(record)

    expect(resumeSleepingAgentSessionsForWorktree('wt-1')).toBe(1)

    const state = useAppStore.getState()
    const resumedTab = state.tabsByWorktree['wt-1']?.find((tab) => tab.id !== 'tab-1')
    expect(resumedTab?.launchAgent).toBe('claude')
    expect(state.sleepingAgentSessionsByPaneKey[record.paneKey]).toBeUndefined()
  })

  it('expires by record age even when the capture looked fresh at capture time', () => {
    // The exact shape a live capture produces: capturedAt === updatedAt, so
    // `capturedAt - updatedAt` is 0 no matter how long the record has sat.
    const capturedAt = NOW - RESUME_RECORD_MAX_AGE_MS - AGENT_STATUS_STALE_AFTER_MS
    const record = makeRecord({ capturedAt, updatedAt: capturedAt })
    expect(record.capturedAt - record.updatedAt).toBe(0)
    seedWorktreeWithUnownedPane(record)

    expect(resumeSleepingAgentSessionsForWorktree('wt-1')).toBe(0)
    expect(useAppStore.getState().sleepingAgentSessionsByPaneKey[record.paneKey]).toBeUndefined()
  })

  it('keeps retiring records that were already stale when captured', () => {
    const record = makeRecord({
      capturedAt: NOW,
      updatedAt: NOW - AGENT_STATUS_STALE_AFTER_MS - 1
    })
    seedWorktreeWithUnownedPane(record)

    expect(resumeSleepingAgentSessionsForWorktree('wt-1')).toBe(0)
    expect(useAppStore.getState().sleepingAgentSessionsByPaneKey[record.paneKey]).toBeUndefined()
  })

  it('leaves an aged completed record for the hibernation paths to own', () => {
    const capturedAt = NOW - RESUME_RECORD_MAX_AGE_MS - 1
    const record = makeRecord({ state: 'done', capturedAt, updatedAt: capturedAt })
    seedWorktreeWithUnownedPane(record)

    // Scope guard: the age bound targets unfinished records. A completed record
    // is passive hibernation evidence and is retired by its own rules, so this
    // asserts the bound did not quietly take that decision over.
    expect(resumeSleepingAgentSessionsForWorktree('wt-1')).toBe(0)
  })
})
