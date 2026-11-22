// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import {
  recordTerminalTabRename,
  resetTerminalSessionNameRecordingForTest
} from './terminal-session-name-recording'
import { reconcileTerminalSessionNames } from './terminal-session-name-pass'
import { LOCAL_TAB_NAME_WRITE_GRACE_MS } from './terminal-session-name-state'
import {
  getSavedTerminalSessionName,
  getTerminalSessionNameEntry,
  resetTerminalSessionNamesForTest,
  saveTerminalSessionName
} from './terminal-session-names'
import {
  makeTerminalNamesState,
  type FixtureTab,
  WORKTREE_ID
} from './terminal-session-names-test-fixture'

const saved = (sessionId: string) => getSavedTerminalSessionName('local', 'claude', sessionId)
const owner = (sessionId: string) => getTerminalSessionNameEntry('local', sessionId)?.tabId

function seed(sessionId: string, title: string, tabId: string) {
  saveTerminalSessionName({
    executionHostId: 'local',
    sessionId,
    agent: 'claude',
    tabId,
    title
  })
}

// Far past any rename's grace window, including renames stamped with the real clock.
const LATER = 10_000_000_000_000
const pass = (tabs: FixtureTab[], now = LATER) =>
  reconcileTerminalSessionNames(makeTerminalNamesState(tabs), now)

describe('terminal session name recording', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    useAppStore.setState(useAppStore.getInitialState(), true)
  })

  beforeEach(() => {
    localStorage.clear()
    resetTerminalSessionNamesForTest()
    resetTerminalSessionNameRecordingForTest()
  })

  describe('rename through the store', () => {
    it('names the session at once, so closing the tab right after keeps it', () => {
      const state = makeTerminalNamesState([{ id: 'tab-1', sessionId: 's1' }])
      useAppStore.setState(state, true)
      useAppStore.getState().setTabCustomTitle('tab-1', 'Fix auth bug')
      expect(useAppStore.getState().tabsByWorktree[WORKTREE_ID]?.[0]?.customTitle).toBe(
        'Fix auth bug'
      )
      // The tab closes before any background pass runs.
      expect(saved('s1')).toBe('Fix auth bug')
      expect(owner('s1')).toBe('tab-1')
    })

    it('takes the name from another tab, as the user asked', () => {
      seed('s1', 'Old', 'tab-9')
      recordTerminalTabRename(
        makeTerminalNamesState([{ id: 'tab-1', sessionId: 's1', customTitle: 'Other' }]),
        'tab-1',
        'New'
      )
      expect(saved('s1')).toBe('New')
      expect(owner('s1')).toBe('tab-1')
    })

    it('forgets every name the cleared tab owns, but not other tabs names', () => {
      seed('s1', 'Mine', 'tab-1')
      seed('s0', 'Mine', 'tab-1') // an earlier session of the same tab (before /clear)
      seed('s2', 'Theirs', 'tab-2')
      recordTerminalTabRename(
        makeTerminalNamesState([
          { id: 'tab-1', sessionId: 's1', customTitle: 'Mine' },
          { id: 'tab-2', sessionId: 's2', customTitle: 'Theirs' }
        ]),
        'tab-1',
        null
      )
      expect(saved('s1')).toBeNull()
      expect(saved('s0')).toBeNull()
      expect(saved('s2')).toBe('Theirs')
    })

    it("clearing a resumed tab forgets its session's name only when the tab showed it", () => {
      seed('s1', 'Fix auth bug', 'closed-tab')
      recordTerminalTabRename(
        makeTerminalNamesState([{ id: 'tab-1', sessionId: 's1', customTitle: 'backend' }]),
        'tab-1',
        null
      )
      expect(saved('s1')).toBe('Fix auth bug')
      recordTerminalTabRename(
        makeTerminalNamesState([{ id: 'tab-2', sessionId: 's1', customTitle: 'Fix auth bug' }]),
        'tab-2',
        ''
      )
      expect(saved('s1')).toBeNull()
    })

    it('saves nothing for a tab whose host is not known yet', () => {
      const state = makeTerminalNamesState([{ id: 'tab-1', sessionId: 's1' }])
      const unknownHost = {
        ...state,
        activeWorktreeId: null,
        activeWorkspaceExecutionHostId: null,
        getKnownWorktreeById: () => undefined
      }
      recordTerminalTabRename(unknownHost, 'tab-1', 'Name')
      expect(saved('s1')).toBeNull()
    })
  })

  describe('background pass', () => {
    it("saves a renamed tab's session once the agent reports it", () => {
      pass([{ id: 'tab-1', customTitle: 'Named first' }])
      expect(saved('s1')).toBeNull()
      pass([{ id: 'tab-1', customTitle: 'Named first', sessionId: 's1' }])
      expect(saved('s1')).toBe('Named first')
    })

    it("follows the owner's renames and clears made on another client", () => {
      seed('s1', 'A', 'tab-1')
      pass([{ id: 'tab-1', sessionId: 's1', customTitle: 'B' }])
      expect(saved('s1')).toBe('B')
      pass([{ id: 'tab-1', sessionId: 's1', customTitle: null }])
      expect(saved('s1')).toBeNull()
    })

    it('never takes a name from another open tab', () => {
      seed('s1', 'Bar', 'tab-2')
      pass([
        { id: 'tab-1', sessionId: 's1', customTitle: 'Foo' },
        { id: 'tab-2', customTitle: 'Bar' }
      ])
      expect(saved('s1')).toBe('Bar')
      expect(owner('s1')).toBe('tab-2')
    })

    it('keeps the name when the session is resumed by hand in a tab named otherwise', () => {
      seed('s1', 'Fix auth bug', 'closed-tab')
      pass([{ id: 'tab-1', sessionId: 's1', customTitle: 'backend' }])
      pass([{ id: 'tab-1', sessionId: 's1', customTitle: 'backend' }])
      expect(saved('s1')).toBe('Fix auth bug')
      expect(owner('s1')).toBe('closed-tab')
    })

    it('a resumed tab showing the saved name takes it over', () => {
      seed('s1', 'Fix auth bug', 'closed-tab')
      pass([{ id: 'tab-new', sessionId: 's1', customTitle: 'Fix auth bug' }])
      expect(owner('s1')).toBe('tab-new')
      // Its later clear then forgets the name.
      pass([{ id: 'tab-new', sessionId: 's1', customTitle: null }])
      expect(saved('s1')).toBeNull()
    })

    it('a tab renamed while running the session takes the name from a closed owner', () => {
      seed('s1', 'Fix auth bug', 'closed-tab')
      pass([{ id: 'tab-1', sessionId: 's1' }])
      pass([{ id: 'tab-1', sessionId: 's1', customTitle: 'Renamed on phone' }])
      expect(saved('s1')).toBe('Renamed on phone')
      expect(owner('s1')).toBe('tab-1')
    })

    it('an exited tab still bound to the session does not revert a newer name', () => {
      seed('s1', 'Bar', 'tab-b')
      const stale = { id: 'tab-a', sessionId: 's1', customTitle: 'Foo' }
      pass([stale, { id: 'tab-b', customTitle: 'Bar' }])
      // tab-b closes.
      pass([stale])
      expect(saved('s1')).toBe('Bar')
    })

    it("does not save a stale echo of the old name after this client's clear", () => {
      const now = 1_000_000
      seed('s1', 'Old', 'tab-1')
      recordTerminalTabRename(
        makeTerminalNamesState([{ id: 'tab-1', sessionId: 's1', customTitle: 'Old' }]),
        'tab-1',
        null,
        { now }
      )
      // main or the paired host has not applied the clear yet.
      const result = pass([{ id: 'tab-1', sessionId: 's1', customTitle: 'Old' }], now + 1)
      expect(saved('s1')).toBeNull()
      expect(result.recheckAt).toBe(now + LOCAL_TAB_NAME_WRITE_GRACE_MS)
    })

    it('gives a rename no say over a session bound after it, or a name a tab was created with', () => {
      const now = 1_000_000
      seed('s2', 'Fix auth bug', 'closed-tab')
      // The user renames a tab running s1, then resumes s2 in it within the grace window.
      recordTerminalTabRename(
        makeTerminalNamesState([{ id: 'tab-1', sessionId: 's1' }]),
        'tab-1',
        'backend',
        { now }
      )
      pass([{ id: 'tab-1', sessionId: 's2', customTitle: 'backend' }], now + 1)
      expect(saved('s2')).toBe('Fix auth bug')

      // A tab named by code, not a person, resumes s2 within the window.
      vi.spyOn(Date, 'now').mockReturnValue(now)
      useAppStore.setState(
        {
          ...makeTerminalNamesState([{ id: 'tab-2', sessionId: 's2' }]),
          activeWorktreeId: null,
          getKnownWorktreeById: () => undefined
        },
        true
      )
      useAppStore.getState().setTabCustomTitle('tab-2', 'Worker 3', { recordInteraction: false })
      pass([{ id: 'tab-2', sessionId: 's2', customTitle: 'Worker 3' }], now + 1)
      expect(saved('s2')).toBe('Fix auth bug')
    })

    it('a resumed tab cleared before its session is known forgets the saved name', () => {
      const now = 1_000_000
      seed('s1', 'Fix auth bug', 'closed-tab')
      // The resume names its new, still unnamed tab through the same rename path.
      recordTerminalTabRename(
        makeTerminalNamesState([{ id: 'tab-new' }]),
        'tab-new',
        'Fix auth bug',
        { now: now - 100, interactive: false }
      )
      recordTerminalTabRename(
        makeTerminalNamesState([{ id: 'tab-new', customTitle: 'Fix auth bug' }]),
        'tab-new',
        null,
        { now }
      )
      pass([{ id: 'tab-new', sessionId: 's1' }], now + 1)
      expect(saved('s1')).toBeNull()
    })

    it('a resumed tab renamed twice while starting still takes the name after a late session report', () => {
      const now = 1_000_000
      seed('s1', 'Fix auth bug', 'closed-tab')
      recordTerminalTabRename(
        makeTerminalNamesState([{ id: 'tab-new' }]),
        'tab-new',
        'Fix auth bug',
        {
          now: now - 100,
          interactive: false
        }
      )
      recordTerminalTabRename(
        makeTerminalNamesState([{ id: 'tab-new', customTitle: 'Fix auth bug' }]),
        'tab-new',
        'Auth, part two',
        { now }
      )
      recordTerminalTabRename(
        makeTerminalNamesState([{ id: 'tab-new', customTitle: 'Auth, part two' }]),
        'tab-new',
        'Auth follow-up',
        { now: now + 5 }
      )
      // A pass sees the final name before the delayed session binding arrives.
      pass([{ id: 'tab-new', customTitle: 'Auth follow-up' }], now + 1_000)
      pass(
        [{ id: 'tab-new', sessionId: 's1', customTitle: 'Auth follow-up' }],
        now + LOCAL_TAB_NAME_WRITE_GRACE_MS * 2
      )
      expect(saved('s1')).toBe('Auth follow-up')
      expect(owner('s1')).toBe('tab-new')
    })

    it('a resumed tab cleared while starting forgets the name even if its session reports late', () => {
      const now = 1_000_000
      seed('s1', 'Fix auth bug', 'closed-tab')
      recordTerminalTabRename(
        makeTerminalNamesState([{ id: 'tab-new', customTitle: 'Fix auth bug' }]),
        'tab-new',
        null,
        { now }
      )
      pass([{ id: 'tab-new', sessionId: 's1' }], now + LOCAL_TAB_NAME_WRITE_GRACE_MS * 2)
      expect(saved('s1')).toBeNull()
    })

    it('clearing a resumed tab renamed while starting, after its session binds, forgets the name', () => {
      const now = 1_000_000
      seed('s1', 'Fix auth bug', 'closed-tab')
      recordTerminalTabRename(
        makeTerminalNamesState([{ id: 'tab-new' }]),
        'tab-new',
        'Fix auth bug',
        {
          now: now - 100,
          interactive: false
        }
      )
      recordTerminalTabRename(
        makeTerminalNamesState([{ id: 'tab-new', customTitle: 'Fix auth bug' }]),
        'tab-new',
        'Auth, part two',
        { now }
      )
      // The agent reports s1, then the user clears the name before any pass runs.
      recordTerminalTabRename(
        makeTerminalNamesState([{ id: 'tab-new', sessionId: 's1', customTitle: 'Auth, part two' }]),
        'tab-new',
        null,
        { now: now + 500 }
      )
      expect(saved('s1')).toBeNull()
      pass([{ id: 'tab-new', sessionId: 's1' }], now + 1_000)
      expect(saved('s1')).toBeNull()
    })

    it('a clear forgets the saved name the tab showed just before, not only its first name', () => {
      const now = 1_000_000
      seed('s1', 'Fix auth bug', 'closed-tab')
      // Renamed while starting from "Scratch" to exactly the saved name, then bound and cleared.
      recordTerminalTabRename(
        makeTerminalNamesState([{ id: 'tab-new', customTitle: 'Scratch' }]),
        'tab-new',
        'Fix auth bug',
        { now }
      )
      recordTerminalTabRename(
        makeTerminalNamesState([{ id: 'tab-new', sessionId: 's1', customTitle: 'Fix auth bug' }]),
        'tab-new',
        null,
        { now: now + 500 }
      )
      expect(saved('s1')).toBeNull()
    })

    it('a rename made while the host was unknown names that session once the host resolves late', () => {
      const now = 1_000_000
      seed('s1', 'Old', 'tab-b')
      const state = makeTerminalNamesState([
        { id: 'tab-a', sessionId: 's1' },
        { id: 'tab-b', customTitle: 'Old' }
      ])
      recordTerminalTabRename(
        { ...state, activeWorktreeId: null, getKnownWorktreeById: () => undefined },
        'tab-a',
        'Mine',
        { now }
      )
      pass(
        [
          { id: 'tab-a', sessionId: 's1', customTitle: 'Mine' },
          { id: 'tab-b', customTitle: 'Old' }
        ],
        now + LOCAL_TAB_NAME_WRITE_GRACE_MS * 3
      )
      expect(saved('s1')).toBe('Mine')
      expect(owner('s1')).toBe('tab-a')
    })

    it("never moves a host-unknown rename's say to a different session", () => {
      const now = 1_000_000
      seed('s2', 'Theirs', 'tab-b')
      const state = makeTerminalNamesState([{ id: 'tab-a', sessionId: 's1' }])
      recordTerminalTabRename(
        { ...state, activeWorktreeId: null, getKnownWorktreeById: () => undefined },
        'tab-a',
        'Mine',
        { now }
      )
      pass(
        [
          { id: 'tab-a', sessionId: 's2', customTitle: 'Mine' },
          { id: 'tab-b', customTitle: 'Theirs' }
        ],
        now + 10
      )
      expect(saved('s2')).toBe('Theirs')
    })

    it('a later rename in another tab is not undone by an earlier one still in its window', () => {
      const now = 1_000_000
      const both = [
        { id: 'tab-a', sessionId: 's1', customTitle: 'Alpha' },
        { id: 'tab-b', sessionId: 's1', customTitle: 'Beta' }
      ]
      recordTerminalTabRename(
        makeTerminalNamesState([both[0], { id: 'tab-b', sessionId: 's1' }]),
        'tab-a',
        'Alpha',
        { now }
      )
      recordTerminalTabRename(makeTerminalNamesState(both), 'tab-b', 'Beta', { now: now + 1 })
      expect(owner('s1')).toBe('tab-b')
      // The pass visits tab-b first, so a replay of tab-a's earlier rename would come last.
      pass([both[1], both[0]], now + 2)
      expect(saved('s1')).toBe('Beta')
      expect(owner('s1')).toBe('tab-b')
    })

    it('a clear made elsewhere during the window is applied after the tab closed', () => {
      const now = 1_000_000
      recordTerminalTabRename(
        makeTerminalNamesState([{ id: 'tab-1', sessionId: 's1', customTitle: 'Draft' }]),
        'tab-1',
        'Mine',
        { now }
      )
      expect(saved('s1')).toBe('Mine')
      // A phone clears the name inside the window; the pass holds back, then the tab closes.
      const held = pass([{ id: 'tab-1', sessionId: 's1' }], now + 10)
      expect(held.recheckAt).toBe(now + LOCAL_TAB_NAME_WRITE_GRACE_MS)
      expect(saved('s1')).toBe('Mine')
      pass([], now + LOCAL_TAB_NAME_WRITE_GRACE_MS)
      expect(saved('s1')).toBeNull()
    })

    it('keeps the rename when what showed after it is also what it replaced', () => {
      const now = 1_000_000
      // Named from an unnamed tab: an unnamed tab afterwards may be the old state echoing back.
      recordTerminalTabRename(
        makeTerminalNamesState([{ id: 'tab-1', sessionId: 's1' }]),
        'tab-1',
        'Mine',
        { now }
      )
      pass([{ id: 'tab-1', sessionId: 's1' }], now + 10)
      pass([], now + LOCAL_TAB_NAME_WRITE_GRACE_MS)
      expect(saved('s1')).toBe('Mine')
    })

    it('a stale echo from before several quick renames is not applied after close', () => {
      const now = 1_000_000
      recordTerminalTabRename(
        makeTerminalNamesState([{ id: 'tab-1', sessionId: 's1', customTitle: 'A' }]),
        'tab-1',
        'B',
        { now }
      )
      recordTerminalTabRename(
        makeTerminalNamesState([{ id: 'tab-1', sessionId: 's1', customTitle: 'B' }]),
        'tab-1',
        'C',
        { now: now + 100 }
      )
      pass([{ id: 'tab-1', sessionId: 's1', customTitle: 'A' }], now + 200)
      pass([], now + 200 + LOCAL_TAB_NAME_WRITE_GRACE_MS)
      expect(saved('s1')).toBe('C')
    })

    it('a host-unknown rename does not undo a name saved for the session after it', () => {
      const now = 1_000_000
      // Saved names are stamped with the clock; keep the two saves in distinct milliseconds.
      let clock = 2_000_000
      vi.spyOn(Date, 'now').mockImplementation(() => clock++)
      const state = makeTerminalNamesState([{ id: 'tab-a', sessionId: 's1' }])
      recordTerminalTabRename(
        { ...state, activeWorktreeId: null, getKnownWorktreeById: () => undefined },
        'tab-a',
        'Old',
        { now }
      )
      // Tab B, whose host is known, names the same session afterwards.
      recordTerminalTabRename(
        makeTerminalNamesState([
          { id: 'tab-a', customTitle: 'Old' },
          { id: 'tab-b', sessionId: 's1' }
        ]),
        'tab-b',
        'New',
        { now: now + 10 }
      )
      pass(
        [
          { id: 'tab-a', sessionId: 's1', customTitle: 'Old' },
          { id: 'tab-b', sessionId: 's1', customTitle: 'New' }
        ],
        now + LOCAL_TAB_NAME_WRITE_GRACE_MS * 3
      )
      expect(saved('s1')).toBe('New')
      expect(owner('s1')).toBe('tab-b')
    })

    it('a name given elsewhere after a local clear is kept when the tab closes in the window', () => {
      const now = 1_000_000
      seed('s1', 'Draft', 'tab-1')
      recordTerminalTabRename(
        makeTerminalNamesState([{ id: 'tab-1', sessionId: 's1', customTitle: 'Draft' }]),
        'tab-1',
        null,
        { now }
      )
      expect(saved('s1')).toBeNull()
      // Another client names the tab inside the window; the pass holds back, then the tab closes.
      pass([{ id: 'tab-1', sessionId: 's1', customTitle: 'Review' }], now + 10)
      pass([], now + LOCAL_TAB_NAME_WRITE_GRACE_MS)
      expect(saved('s1')).toBe('Review')
    })

    it('keeps the saved name when naming a resumed tab failed', () => {
      seed('s1', 'Fix auth bug', 'closed-tab')
      // The host ignored the name, so the resumed tab stays unnamed.
      pass([{ id: 'tab-new', sessionId: 's1' }])
      pass([{ id: 'tab-new', sessionId: 's1' }])
      expect(saved('s1')).toBe('Fix auth bug')
      expect(owner('s1')).toBe('closed-tab')
    })

    it('records names of agents beyond Claude and Codex', () => {
      pass([
        {
          id: 'tab-1',
          sessionId: 'oc1',
          agent: 'opencode',
          customTitle: 'Docs'
        }
      ])
      expect(getSavedTerminalSessionName('local', 'opencode2', 'oc1')).toBe('Docs')
    })
  })
})
