// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest'
import {
  LOCAL_TAB_NAME_WRITE_GRACE_MS,
  reconcileTerminalSessionNames,
  recordTerminalTabRename,
  resetTerminalSessionNameRecordingForTest
} from './terminal-session-name-recording'
import {
  getSavedTerminalSessionName,
  getTerminalSessionNameEntry,
  resetTerminalSessionNamesForTest,
  saveTerminalSessionName
} from './terminal-session-names'
import { makeTerminalNamesState, type FixtureTab } from './terminal-session-names-test-fixture'

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
  beforeEach(() => {
    localStorage.clear()
    resetTerminalSessionNamesForTest()
    resetTerminalSessionNameRecordingForTest()
  })

  describe('rename through the store', () => {
    it('names the session at once, so closing the tab right after keeps it', () => {
      const state = makeTerminalNamesState([{ id: 'tab-1', sessionId: 's1' }])
      recordTerminalTabRename(state, 'tab-1', 'Fix auth bug')
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

    it('names the session once a rename made while its host was unknown shows', () => {
      const now = 1_000_000
      const state = makeTerminalNamesState([{ id: 'tab-1', sessionId: 's1' }])
      seed('s1', 'Other tab name', 'tab-2')
      recordTerminalTabRename(
        {
          ...state,
          activeWorktreeId: null,
          getKnownWorktreeById: () => undefined
        },
        'tab-1',
        'Mine',
        { now }
      )
      pass(
        [
          { id: 'tab-1', sessionId: 's1', customTitle: 'Mine' },
          { id: 'tab-2', customTitle: 'Other tab name' }
        ],
        now + 1
      )
      expect(saved('s1')).toBe('Mine')
      expect(owner('s1')).toBe('tab-1')
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
      recordTerminalTabRename(
        {
          ...makeTerminalNamesState([{ id: 'tab-2', sessionId: 's2' }]),
          activeWorktreeId: null,
          getKnownWorktreeById: () => undefined
        },
        'tab-2',
        'Worker 3',
        { now, interactive: false }
      )
      pass([{ id: 'tab-2', sessionId: 's2', customTitle: 'Worker 3' }], now + 1)
      expect(saved('s2')).toBe('Fix auth bug')
    })

    it('a resumed tab renamed before its session is known takes the saved name', () => {
      const now = 1_000_000
      seed('s1', 'Fix auth bug', 'closed-tab')
      // The resumed tab shows the saved name; the user renames it before the agent reports s1.
      recordTerminalTabRename(
        makeTerminalNamesState([{ id: 'tab-new', customTitle: 'Fix auth bug' }]),
        'tab-new',
        'Auth, part two',
        { now }
      )
      pass([{ id: 'tab-new', sessionId: 's1', customTitle: 'Auth, part two' }], now + 1)
      expect(saved('s1')).toBe('Auth, part two')
      expect(owner('s1')).toBe('tab-new')
    })

    it('keeps the saved name when naming a resumed tab failed', () => {
      seed('s1', 'Fix auth bug', 'closed-tab')
      // The host ignored the name, so the resumed tab stays unnamed.
      pass([{ id: 'tab-new', sessionId: 's1' }])
      pass([{ id: 'tab-new', sessionId: 's1' }])
      expect(saved('s1')).toBe('Fix auth bug')
      expect(owner('s1')).toBe('closed-tab')
    })

    it('reports skipped tabs whose host is not known yet', () => {
      const state = makeTerminalNamesState([{ id: 'tab-1', sessionId: 's1', customTitle: 'N' }])
      const result = reconcileTerminalSessionNames(
        {
          ...state,
          activeWorktreeId: null,
          activeWorkspaceExecutionHostId: null,
          getKnownWorktreeById: () => undefined
        },
        LATER
      )
      expect(result.hostSkipped).toBe(true)
      expect(saved('s1')).toBeNull()
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
