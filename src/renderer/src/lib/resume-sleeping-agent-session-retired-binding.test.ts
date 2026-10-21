import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'
import { makePaneKey } from '../../../shared/stable-pane-id'
import { useAppStore } from '@/store'
import { resumeSleepingAgentSessionsForWorktree } from './resume-sleeping-agent-session'
import { recordPaneIsOwnedByPreservedPane } from './sleeping-agent-pane-ownership'
import { holdPaneResumeInPlace } from './pane-spawn-deferral-registry'

const mocks = vi.hoisted(() => ({ layoutOwnerIsMain: false, launch: vi.fn(() => true) }))

vi.mock('../../../shared/layout-owner-switch', () => ({
  get ORCA_LAYOUT_OWNER_IS_MAIN() {
    return mocks.layoutOwnerIsMain
  }
}))

// The sweep's decision is under test; the new tab it would open is not.
vi.mock('./sleeping-agent-session-launch', () => ({
  launchSleepingAgentSession: mocks.launch
}))

const initialAppStoreState = useAppStore.getState()
const LEAF_ID = '55555555-5555-4555-8555-555555555555'
const PANE_KEY = makePaneKey('tab-1', LEAF_ID)

afterEach(() => {
  mocks.layoutOwnerIsMain = false
  mocks.launch.mockClear()
  useAppStore.setState(initialAppStoreState, true)
})

const record: SleepingAgentSessionRecord = {
  paneKey: PANE_KEY,
  worktreeId: 'wt-1',
  agent: 'codex',
  providerSession: { key: 'session_id', id: 'sess-retired' },
  prompt: 'keep working',
  state: 'working',
  capturedAt: 1,
  updatedAt: 1,
  origin: 'quit'
}

// A pane in the layout with no terminal bound: either main cleared a gone terminal's binding
// during the pane's reattach (a first visit after a reboot), or the pane's agent died in place.
function retiredBindingState(): void {
  useAppStore.setState({
    activeWorktreeId: 'wt-1',
    activeTabType: 'terminal',
    activeTabId: 'tab-1',
    activeTabIdByWorktree: { 'wt-1': 'tab-1' },
    tabsByWorktree: {
      'wt-1': [
        {
          id: 'tab-1',
          ptyId: null,
          worktreeId: 'wt-1',
          title: 'codex',
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: 1
        }
      ]
    },
    terminalLayoutsByTabId: {
      'tab-1': {
        root: { type: 'leaf', leafId: LEAF_ID },
        activeLeafId: LEAF_ID,
        expandedLeafId: null
      }
    },
    ptyIdsByTabId: {},
    sleepingAgentSessionsByPaneKey: { [PANE_KEY]: record }
  })
}

describe('a resume record whose pane has no terminal bound', () => {
  it('on main-owned layouts, is left to the pane while its own start resumes it in place', () => {
    mocks.layoutOwnerIsMain = true
    retiredBindingState()
    // The pane's reattach is in flight; main has cleared the gone terminal's binding meanwhile.
    const release = holdPaneResumeInPlace(PANE_KEY, () => true)
    try {
      expect(recordPaneIsOwnedByPreservedPane(record, useAppStore.getState())).toBe(true)
      expect(resumeSleepingAgentSessionsForWorktree('wt-1')).toBe(0)
      expect(mocks.launch).not.toHaveBeenCalled()
      const state = useAppStore.getState()
      expect(state.tabsByWorktree['wt-1']?.map((tab) => tab.id)).toEqual(['tab-1'])
      expect(state.sleepingAgentSessionsByPaneKey[PANE_KEY]).toBe(record)
    } finally {
      release()
    }
  })

  it('on main-owned layouts, a mounted pane whose agent died is not its owner: the sweep resumes it', () => {
    mocks.layoutOwnerIsMain = true
    retiredBindingState()

    expect(recordPaneIsOwnedByPreservedPane(record, useAppStore.getState())).toBe(false)
    expect(resumeSleepingAgentSessionsForWorktree('wt-1')).toBe(1)
    expect(mocks.launch).toHaveBeenCalledWith(record, undefined)
  })

  it('a start that settled, or a disposed pane, no longer owns it', () => {
    mocks.layoutOwnerIsMain = true
    retiredBindingState()
    holdPaneResumeInPlace(PANE_KEY, () => true)()
    const disposedRelease = holdPaneResumeInPlace(PANE_KEY, () => false)
    try {
      expect(recordPaneIsOwnedByPreservedPane(record, useAppStore.getState())).toBe(false)
    } finally {
      disposedRelease()
    }
  })

  it('keeps the window-owned rule: an unbound pane does not own it, in flight or not', () => {
    retiredBindingState()
    const release = holdPaneResumeInPlace(PANE_KEY, () => true)
    try {
      expect(recordPaneIsOwnedByPreservedPane(record, useAppStore.getState())).toBe(false)
    } finally {
      release()
    }
    expect(resumeSleepingAgentSessionsForWorktree('wt-1')).toBe(1)
    expect(mocks.launch).toHaveBeenCalledWith(record, undefined)
  })
})
