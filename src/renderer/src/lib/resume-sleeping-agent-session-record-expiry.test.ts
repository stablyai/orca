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
// Ownership only resolves for a stable pane key, whose leaf half must be a real
// terminal leaf id; 'leaf-1' does not parse and silently reads as unowned.
const OWNED_LEAF_ID = '11111111-1111-4111-8111-111111111111'
const OWNED_PANE_KEY = `tab-1:${OWNED_LEAF_ID}`

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

function seedWorktreeWithOwnedPane(record: SleepingAgentSessionRecord): void {
  const tabId = 'tab-1'
  const leafId = OWNED_LEAF_ID
  useAppStore.setState({
    activeWorktreeId: 'wt-1',
    activeTabType: 'terminal',
    activeTabId: tabId,
    activeTabIdByWorktree: { 'wt-1': tabId },
    tabsByWorktree: {
      'wt-1': [
        {
          id: tabId,
          ptyId: 'pty-1',
          worktreeId: 'wt-1',
          title: 'shell',
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: 1
        }
      ]
    },
    terminalLayoutsByTabId: {
      [tabId]: {
        root: { type: 'leaf', leafId },
        activeLeafId: leafId,
        expandedLeafId: null,
        ptyIdsByLeafId: { [leafId]: 'pty-1' }
      }
    },
    ptyIdsByTabId: { [tabId]: ['pty-1'] },
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

  it('leaves an aged completed record owned by its pane untouched', () => {
    // Covers the ownership gate, not the done guard: the expiry branch is already
    // skipped for an owned record whatever its state.
    const capturedAt = NOW - RESUME_RECORD_MAX_AGE_MS - 1
    const record = makeRecord({
      paneKey: OWNED_PANE_KEY,
      state: 'done',
      capturedAt,
      updatedAt: capturedAt
    })
    seedWorktreeWithOwnedPane(record)

    expect(resumeSleepingAgentSessionsForWorktree('wt-1')).toBe(0)
    expect(useAppStore.getState().sleepingAgentSessionsByPaneKey[record.paneKey]).toBe(record)
  })

  it('still resumes an aged quit record, which the done guard exempts from expiry', () => {
    // The only shape that isolates `state !== 'done'` in isExpiredResumeRecord:
    // unowned (so the expiry branch is reachable) and origin 'quit' (so the
    // passive-hibernation branch does not clear it first). Drop that guard and
    // this record is expired instead of resumed.
    const capturedAt = NOW - RESUME_RECORD_MAX_AGE_MS - 1
    const record = makeRecord({ state: 'done', origin: 'quit', capturedAt, updatedAt: capturedAt })
    seedWorktreeWithUnownedPane(record)

    expect(resumeSleepingAgentSessionsForWorktree('wt-1')).toBe(1)
    expect(useAppStore.getState().sleepingAgentSessionsByPaneKey[record.paneKey]).toBeUndefined()
  })

  it('does not let an expiring record evict a healthy sharer of its claim key', () => {
    // Both records name the same session, so they share a claim key and the loop
    // keeps only the "newest active" one. The unfinished record is newer but
    // expiring; if it is allowed into that map it wins, the quit record is
    // dropped for not being newest, and then it is itself expired — losing both
    // with nothing resumed.
    const quitCapturedAt = NOW - RESUME_RECORD_MAX_AGE_MS - 2_000
    const expiringCapturedAt = NOW - RESUME_RECORD_MAX_AGE_MS - 1_000
    const quitRecord = makeRecord({
      paneKey: 'tab-1:leaf-quit',
      tabId: 'tab-1',
      state: 'done',
      origin: 'quit',
      capturedAt: quitCapturedAt,
      updatedAt: quitCapturedAt
    })
    const expiringRecord = makeRecord({
      paneKey: 'tab-1:leaf-expiring',
      tabId: 'tab-1',
      capturedAt: expiringCapturedAt,
      updatedAt: expiringCapturedAt
    })
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
      sleepingAgentSessionsByPaneKey: {
        [quitRecord.paneKey]: quitRecord,
        [expiringRecord.paneKey]: expiringRecord
      }
    } as never)

    expect(resumeSleepingAgentSessionsForWorktree('wt-1')).toBe(1)
    const state = useAppStore.getState()
    expect(state.sleepingAgentSessionsByPaneKey[expiringRecord.paneKey]).toBeUndefined()
  })

  it('keeps an aged unfinished record whose pane is still owned', () => {
    // Only an orphan is dead weight. A live pane still owns its session even if
    // its agent stopped reporting, so expiring the record would delete the
    // evidence that pane needs to recover.
    const capturedAt = NOW - RESUME_RECORD_MAX_AGE_MS - 1
    const record = makeRecord({ paneKey: OWNED_PANE_KEY, capturedAt, updatedAt: capturedAt })
    seedWorktreeWithOwnedPane(record)

    expect(resumeSleepingAgentSessionsForWorktree('wt-1')).toBe(0)
    expect(useAppStore.getState().sleepingAgentSessionsByPaneKey[record.paneKey]).toBe(record)
  })
})
