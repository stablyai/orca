import { afterEach, describe, expect, it } from 'vitest'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'
import { makePaneKey } from '../../../shared/stable-pane-id'
import { useAppStore } from '@/store'
import { recordPaneIsOwnedByPreservedPane } from './sleeping-agent-pane-ownership'
import { resumeSleepingAgentSessionsForWorktree } from './resume-sleeping-agent-session'

const initialAppStoreState = useAppStore.getState()
const WORKTREE_ID = 'wt-1'
const TAB_ID = 'tab-1'
const PANE_KEY = makePaneKey(TAB_ID, '11111111-1111-4111-8111-111111111111')

afterEach(() => {
  useAppStore.setState(initialAppStoreState, true)
})

describe('preserved sleeping-agent pane ownership', () => {
  it('keeps quit recovery on a preserved tab when its terminal layout was lost', () => {
    const record: SleepingAgentSessionRecord = {
      paneKey: PANE_KEY,
      tabId: TAB_ID,
      worktreeId: WORKTREE_ID,
      agent: 'claude',
      providerSession: { key: 'session_id', id: 'sess-1' },
      prompt: 'finish the task',
      state: 'working',
      capturedAt: 1,
      updatedAt: 1,
      origin: 'quit'
    }
    useAppStore.setState({
      activeWorktreeId: WORKTREE_ID,
      activeTabType: 'terminal',
      activeTabId: TAB_ID,
      activeTabIdByWorktree: { [WORKTREE_ID]: TAB_ID },
      tabsByWorktree: {
        [WORKTREE_ID]: [
          {
            id: TAB_ID,
            ptyId: null,
            worktreeId: WORKTREE_ID,
            title: 'shell',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          }
        ]
      },
      terminalLayoutsByTabId: {},
      sleepingAgentSessionsByPaneKey: { [PANE_KEY]: record }
    } as never)

    const launched = resumeSleepingAgentSessionsForWorktree(WORKTREE_ID)
    const state = useAppStore.getState()

    expect(launched).toBe(0)
    expect(state.tabsByWorktree[WORKTREE_ID]).toHaveLength(1)
    expect(state.sleepingAgentSessionsByPaneKey[PANE_KEY]).toBe(record)
  })

  it('claims rebuilt-tab recovery only for the unique adoptable record', () => {
    const makeRecord = (
      leafId: string,
      overrides: Partial<SleepingAgentSessionRecord> = {}
    ): SleepingAgentSessionRecord => ({
      paneKey: makePaneKey(TAB_ID, leafId),
      tabId: TAB_ID,
      worktreeId: WORKTREE_ID,
      agent: 'claude',
      providerSession: { key: 'session_id', id: `sess-${leafId.slice(0, 1)}` },
      prompt: 'finish the task',
      state: 'working',
      capturedAt: 1,
      updatedAt: 1,
      origin: 'quit',
      ...overrides
    })
    const first = makeRecord('11111111-1111-4111-8111-111111111111')
    const second = makeRecord('22222222-2222-4222-8222-222222222222')
    const completed = makeRecord('33333333-3333-4333-8333-333333333333', {
      state: 'done',
      origin: undefined
    })
    const baseState = {
      activeWorktreeId: WORKTREE_ID,
      activeTabType: 'terminal',
      activeTabId: TAB_ID,
      tabsByWorktree: {
        [WORKTREE_ID]: [{ id: TAB_ID, ptyId: null, worktreeId: WORKTREE_ID }]
      },
      terminalLayoutsByTabId: {},
      ptyIdsByTabId: {}
    }

    // Two live records on one rebuilt tab are ambiguous: neither may claim the
    // pane, so activation keeps the fork-a-new-tab recovery for both.
    const ambiguous = {
      ...baseState,
      sleepingAgentSessionsByPaneKey: { [first.paneKey]: first, [second.paneKey]: second }
    } as never
    expect(recordPaneIsOwnedByPreservedPane(first, ambiguous)).toBe(false)
    expect(recordPaneIsOwnedByPreservedPane(second, ambiguous)).toBe(false)

    // A completed sibling is not an adoption candidate and must not break the
    // live record's unique claim.
    const withCompletedSibling = {
      ...baseState,
      sleepingAgentSessionsByPaneKey: { [first.paneKey]: first, [completed.paneKey]: completed }
    } as never
    expect(recordPaneIsOwnedByPreservedPane(first, withCompletedSibling)).toBe(true)
    expect(recordPaneIsOwnedByPreservedPane(completed, withCompletedSibling)).toBe(false)

    // Duplicate rows for one provider session are a single recovery identity:
    // the freshest row claims the pane, older duplicates defer to it.
    const sharedSession = { key: 'session_id', id: 'sess-shared' } as const
    const olderDuplicate = makeRecord('11111111-1111-4111-8111-111111111111', {
      providerSession: sharedSession,
      updatedAt: 1
    })
    const newerDuplicate = makeRecord('22222222-2222-4222-8222-222222222222', {
      providerSession: sharedSession,
      updatedAt: 2
    })
    const withDuplicates = {
      ...baseState,
      sleepingAgentSessionsByPaneKey: {
        [olderDuplicate.paneKey]: olderDuplicate,
        [newerDuplicate.paneKey]: newerDuplicate
      }
    } as never
    expect(recordPaneIsOwnedByPreservedPane(newerDuplicate, withDuplicates)).toBe(true)
    expect(recordPaneIsOwnedByPreservedPane(olderDuplicate, withDuplicates)).toBe(false)

    // A legacy-numeric row on the tab defers rebuilt-leaf adoption entirely:
    // connectPanePty resolves legacy selection separately, so stable records
    // keep the fork-a-new-tab recovery instead of racing it.
    const legacyRecord: SleepingAgentSessionRecord = {
      ...makeRecord('11111111-1111-4111-8111-111111111111'),
      paneKey: `${TAB_ID}:2`
    }
    const withLegacySibling = {
      ...baseState,
      sleepingAgentSessionsByPaneKey: {
        [first.paneKey]: first,
        [legacyRecord.paneKey]: legacyRecord
      }
    } as never
    expect(recordPaneIsOwnedByPreservedPane(first, withLegacySibling)).toBe(false)

    // Worktree-sleep and originless legacy captures keep the fork-a-new-tab
    // wake path; adopting them here would race that path into a double resume.
    const worktreeSleep = makeRecord('11111111-1111-4111-8111-111111111111', {
      origin: 'worktree-sleep'
    })
    const originless = makeRecord('22222222-2222-4222-8222-222222222222', {
      origin: undefined
    })
    const withNonRecoveryOrigins = {
      ...baseState,
      sleepingAgentSessionsByPaneKey: {
        [worktreeSleep.paneKey]: worktreeSleep,
        [originless.paneKey]: originless
      }
    } as never
    expect(recordPaneIsOwnedByPreservedPane(worktreeSleep, withNonRecoveryOrigins)).toBe(false)
    expect(recordPaneIsOwnedByPreservedPane(originless, withNonRecoveryOrigins)).toBe(false)
  })
})
