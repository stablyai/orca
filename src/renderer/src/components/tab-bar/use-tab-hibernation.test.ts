// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach } from 'vitest'
import {
  isTerminalTabSleeping,
  getSleepablePanesForTerminalTab,
  sleepTerminalTab,
  wakeTerminalTab,
  useTabHibernation
} from './use-tab-hibernation'
import { useAppStore } from '@/store'
import type { SleepingAgentSessionRecord } from '../../../../shared/agent-session/lifecycle/agent-session-resume'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import { WAKE_HIBERNATED_AGENTS_WORKTREE_EVENT } from '@/constants/terminal'
import { renderHook } from '@testing-library/react'

const LEAF_UUID_1 = '11111111-1111-4111-8111-111111111111'
const LEAF_UUID_2 = '22222222-2222-4222-8222-222222222222'

function makeSleepingRecord(
  overrides: Partial<SleepingAgentSessionRecord> = {}
): SleepingAgentSessionRecord {
  return {
    paneKey: `tab-1:${LEAF_UUID_1}`,
    tabId: 'tab-1',
    worktreeId: 'wt-1',
    agent: 'claude',
    providerSession: { key: 'session_id', id: 'conv-1' },
    prompt: 'hello',
    state: 'done',
    capturedAt: 100,
    updatedAt: 100,
    origin: 'worktree-sleep',
    ...overrides
  }
}

function makeTab(id = 'tab-1', worktreeId = 'wt-1'): TerminalTab {
  return {
    id,
    worktreeId,
    title: 'Terminal 1',
    defaultTitle: 'Terminal 1',
    createdAt: 100,
    ptyId: 'pty-1',
    startupCwd: '/repo',
    customTitle: null,
    color: null,
    sortOrder: 0
  }
}

function makeAgentEntry(overrides: Partial<AgentStatusEntry> = {}): AgentStatusEntry {
  return {
    paneKey: `tab-1:${LEAF_UUID_1}`,
    tabId: 'tab-1',
    worktreeId: 'wt-1',
    agentType: 'claude',
    state: 'done',
    stateStartedAt: 100,
    updatedAt: 100,
    prompt: '',
    stateHistory: [],
    providerSession: { key: 'session_id', id: 'conv-1' },
    ...overrides
  }
}

describe('use-tab-hibernation', () => {
  describe('isTerminalTabSleeping', () => {
    it('returns true when tab has 0 live PTYs and a resumable sleeping record', () => {
      const state = {
        ptyIdsByTabId: { 'tab-1': [] },
        sleepingAgentSessionsByPaneKey: {
          [`tab-1:${LEAF_UUID_1}`]: makeSleepingRecord()
        }
      }
      expect(isTerminalTabSleeping(state, 'tab-1')).toBe(true)
    })

    it('returns false when tab has live PTYs', () => {
      const state = {
        ptyIdsByTabId: { 'tab-1': ['pty-1'] },
        sleepingAgentSessionsByPaneKey: {
          [`tab-1:${LEAF_UUID_1}`]: makeSleepingRecord()
        }
      }
      expect(isTerminalTabSleeping(state, 'tab-1')).toBe(false)
    })

    it('returns false when sleeping record is an active live anchor', () => {
      const state = {
        ptyIdsByTabId: { 'tab-1': [] },
        sleepingAgentSessionsByPaneKey: {
          [`tab-1:${LEAF_UUID_1}`]: makeSleepingRecord({ origin: 'live' })
        }
      }
      expect(isTerminalTabSleeping(state, 'tab-1')).toBe(false)
    })

    it('returns false when sleeping record is a quit capture', () => {
      const state = {
        ptyIdsByTabId: { 'tab-1': [] },
        sleepingAgentSessionsByPaneKey: {
          [`tab-1:${LEAF_UUID_1}`]: makeSleepingRecord({ origin: 'quit' })
        }
      }
      expect(isTerminalTabSleeping(state, 'tab-1')).toBe(false)
    })

    it('returns false when sleeping record belongs to a different tab', () => {
      const state = {
        ptyIdsByTabId: { 'tab-1': [] },
        sleepingAgentSessionsByPaneKey: {
          [`tab-2:${LEAF_UUID_1}`]: makeSleepingRecord({
            tabId: 'tab-2',
            paneKey: `tab-2:${LEAF_UUID_1}`
          })
        }
      }
      expect(isTerminalTabSleeping(state, 'tab-1')).toBe(false)
    })

    it('returns false when sleeping record has no resume argv', () => {
      const state = {
        ptyIdsByTabId: { 'tab-1': [] },
        sleepingAgentSessionsByPaneKey: {
          // pi requires transcriptPath to resume
          [`tab-1:${LEAF_UUID_1}`]: makeSleepingRecord({
            agent: 'pi',
            providerSession: { key: 'session_id', id: 'conv-1' }
          })
        }
      }
      expect(isTerminalTabSleeping(state, 'tab-1')).toBe(false)
    })
  })

  describe('getSleepablePanesForTerminalTab', () => {
    it('returns sleepable target when agent is done and resumable', () => {
      const tab = makeTab('tab-1', 'wt-1')
      const entry = makeAgentEntry()
      const state = {
        tabsByWorktree: { 'wt-1': [tab] },
        terminalLayoutsByTabId: {
          'tab-1': {
            activeLeafId: LEAF_UUID_1,
            root: { type: 'leaf' as const, leafId: LEAF_UUID_1 },
            ptyIdsByLeafId: { [LEAF_UUID_1]: 'pty-1' }
          }
        },
        ptyIdsByTabId: { 'tab-1': ['pty-1'] },
        agentStatusByPaneKey: { [`tab-1:${LEAF_UUID_1}`]: entry },
        sleepingAgentSessionsByPaneKey: {},
        lastTerminalInputAtByPaneKey: {},
        foregroundTerminalLastSeenAtByTabId: {},
        ptyBindingFirstSeenAtByPaneKey: {},
        boundaryResolvedAtByPaneKey: {}
      }

      const sleepable = getSleepablePanesForTerminalTab(state as never, 'wt-1', 'tab-1')
      expect(sleepable).toEqual([
        {
          paneKey: `tab-1:${LEAF_UUID_1}`,
          tabId: 'tab-1',
          leafId: LEAF_UUID_1,
          ptyId: 'pty-1',
          expectedRuntimePtyId: 'pty-1'
        }
      ])
    })

    it('returns empty list when agent is working', () => {
      const tab = makeTab('tab-1', 'wt-1')
      const entry = makeAgentEntry({ state: 'working' })
      const state = {
        tabsByWorktree: { 'wt-1': [tab] },
        terminalLayoutsByTabId: {
          'tab-1': {
            activeLeafId: LEAF_UUID_1,
            root: { type: 'leaf' as const, leafId: LEAF_UUID_1 },
            ptyIdsByLeafId: { [LEAF_UUID_1]: 'pty-1' }
          }
        },
        ptyIdsByTabId: { 'tab-1': ['pty-1'] },
        agentStatusByPaneKey: { [`tab-1:${LEAF_UUID_1}`]: entry },
        sleepingAgentSessionsByPaneKey: {},
        lastTerminalInputAtByPaneKey: {},
        foregroundTerminalLastSeenAtByTabId: {},
        ptyBindingFirstSeenAtByPaneKey: {},
        boundaryResolvedAtByPaneKey: {}
      }

      expect(getSleepablePanesForTerminalTab(state as never, 'wt-1', 'tab-1')).toEqual([])
    })

    it('returns empty list when unsubmitted input was typed', () => {
      const tab = makeTab('tab-1', 'wt-1')
      const entry = makeAgentEntry({ stateStartedAt: 100 })
      const state = {
        tabsByWorktree: { 'wt-1': [tab] },
        terminalLayoutsByTabId: {
          'tab-1': {
            activeLeafId: LEAF_UUID_1,
            root: { type: 'leaf' as const, leafId: LEAF_UUID_1 },
            ptyIdsByLeafId: { [LEAF_UUID_1]: 'pty-1' }
          }
        },
        ptyIdsByTabId: { 'tab-1': ['pty-1'] },
        agentStatusByPaneKey: { [`tab-1:${LEAF_UUID_1}`]: entry },
        sleepingAgentSessionsByPaneKey: {},
        lastTerminalInputAtByPaneKey: { [`tab-1:${LEAF_UUID_1}`]: 200 },
        foregroundTerminalLastSeenAtByTabId: {},
        ptyBindingFirstSeenAtByPaneKey: {},
        boundaryResolvedAtByPaneKey: {}
      }

      expect(getSleepablePanesForTerminalTab(state as never, 'wt-1', 'tab-1')).toEqual([])
    })

    it('returns empty list when subagents are active', () => {
      const tab = makeTab('tab-1', 'wt-1')
      const entry = makeAgentEntry({ subagents: ['sub-1'] as never })
      const state = {
        tabsByWorktree: { 'wt-1': [tab] },
        terminalLayoutsByTabId: {
          'tab-1': {
            activeLeafId: LEAF_UUID_1,
            root: { type: 'leaf' as const, leafId: LEAF_UUID_1 },
            ptyIdsByLeafId: { [LEAF_UUID_1]: 'pty-1' }
          }
        },
        ptyIdsByTabId: { 'tab-1': ['pty-1'] },
        agentStatusByPaneKey: { [`tab-1:${LEAF_UUID_1}`]: entry },
        sleepingAgentSessionsByPaneKey: {},
        lastTerminalInputAtByPaneKey: {},
        foregroundTerminalLastSeenAtByTabId: {},
        ptyBindingFirstSeenAtByPaneKey: {},
        boundaryResolvedAtByPaneKey: {}
      }

      expect(getSleepablePanesForTerminalTab(state as never, 'wt-1', 'tab-1')).toEqual([])
    })

    it('returns empty list if one pane of a split tab is working', () => {
      const tab = makeTab('tab-1', 'wt-1')
      const entry1 = makeAgentEntry({ paneKey: `tab-1:${LEAF_UUID_1}`, state: 'done' })
      const entry2 = makeAgentEntry({ paneKey: `tab-1:${LEAF_UUID_2}`, state: 'working' })
      const state = {
        tabsByWorktree: { 'wt-1': [tab] },
        terminalLayoutsByTabId: {
          'tab-1': {
            activeLeafId: LEAF_UUID_1,
            root: {
              type: 'split' as const,
              direction: 'horizontal' as const,
              children: [
                { type: 'leaf' as const, leafId: LEAF_UUID_1 },
                { type: 'leaf' as const, leafId: LEAF_UUID_2 }
              ]
            },
            ptyIdsByLeafId: { [LEAF_UUID_1]: 'pty-1', [LEAF_UUID_2]: 'pty-2' }
          }
        },
        ptyIdsByTabId: { 'tab-1': ['pty-1', 'pty-2'] },
        agentStatusByPaneKey: {
          [`tab-1:${LEAF_UUID_1}`]: entry1,
          [`tab-1:${LEAF_UUID_2}`]: entry2
        },
        sleepingAgentSessionsByPaneKey: {},
        lastTerminalInputAtByPaneKey: {},
        foregroundTerminalLastSeenAtByTabId: {},
        ptyBindingFirstSeenAtByPaneKey: {},
        boundaryResolvedAtByPaneKey: {}
      }

      expect(getSleepablePanesForTerminalTab(state as never, 'wt-1', 'tab-1')).toEqual([])
    })
  })

  describe('sleepTerminalTab', () => {
    beforeEach(() => {
      useAppStore.setState(useAppStore.getInitialState(), true)
    })

    it('switches to a sibling tab before hibernating when active tab has siblings', async () => {
      const tab1 = makeTab('tab-1', 'wt-1')
      const tab2 = makeTab('tab-2', 'wt-1')
      const entry = makeAgentEntry()
      const shutdownMock = vi.fn(async () => {})
      const onActivateMock = vi.fn()

      useAppStore.setState({
        activeWorktreeId: 'wt-1',
        activeTabId: 'tab-1',
        tabsByWorktree: { 'wt-1': [tab1, tab2] },
        terminalLayoutsByTabId: {
          'tab-1': {
            activeLeafId: LEAF_UUID_1,
            expandedLeafId: null,
            root: { type: 'leaf' as const, leafId: LEAF_UUID_1 },
            ptyIdsByLeafId: { [LEAF_UUID_1]: 'pty-1' }
          }
        },
        ptyIdsByTabId: { 'tab-1': ['pty-1'] },
        agentStatusByPaneKey: { [`tab-1:${LEAF_UUID_1}`]: entry },
        shutdownCompletedAgentPaneForHibernation: shutdownMock as never
      })

      await sleepTerminalTab({
        worktreeId: 'wt-1',
        tabId: 'tab-1',
        isActive: true,
        onActivate: onActivateMock
      })

      expect(onActivateMock).toHaveBeenCalledWith('tab-2')
      expect(shutdownMock).toHaveBeenCalledWith('wt-1', {
        paneKey: `tab-1:${LEAF_UUID_1}`,
        tabId: 'tab-1',
        leafId: LEAF_UUID_1,
        ptyId: 'pty-1',
        expectedRuntimePtyId: 'pty-1',
        restoreOnTabOpenOnly: true
      })
    })

    it('hibernates in place without tab switch when it is the only tab', async () => {
      const tab1 = makeTab('tab-1', 'wt-1')
      const entry = makeAgentEntry()
      const shutdownMock = vi.fn(async () => {})
      const onActivateMock = vi.fn()

      useAppStore.setState({
        activeWorktreeId: 'wt-1',
        activeTabId: 'tab-1',
        tabsByWorktree: { 'wt-1': [tab1] },
        terminalLayoutsByTabId: {
          'tab-1': {
            activeLeafId: LEAF_UUID_1,
            expandedLeafId: null,
            root: { type: 'leaf' as const, leafId: LEAF_UUID_1 },
            ptyIdsByLeafId: { [LEAF_UUID_1]: 'pty-1' }
          }
        },
        ptyIdsByTabId: { 'tab-1': ['pty-1'] },
        agentStatusByPaneKey: { [`tab-1:${LEAF_UUID_1}`]: entry },
        shutdownCompletedAgentPaneForHibernation: shutdownMock as never
      })

      await sleepTerminalTab({
        worktreeId: 'wt-1',
        tabId: 'tab-1',
        isActive: true,
        onActivate: onActivateMock
      })

      expect(onActivateMock).not.toHaveBeenCalled()
      expect(shutdownMock).toHaveBeenCalledWith('wt-1', {
        paneKey: `tab-1:${LEAF_UUID_1}`,
        tabId: 'tab-1',
        leafId: LEAF_UUID_1,
        ptyId: 'pty-1',
        expectedRuntimePtyId: 'pty-1',
        restoreOnTabOpenOnly: true
      })
    })
  })

  describe('wakeTerminalTab', () => {
    it('calls onActivate and dispatches WAKE_HIBERNATED_AGENTS_WORKTREE_EVENT', () => {
      const onActivateMock = vi.fn()
      const dispatchSpy = vi.spyOn(window, 'dispatchEvent')

      wakeTerminalTab('wt-1', 'tab-1', onActivateMock)

      expect(onActivateMock).toHaveBeenCalledWith('tab-1')
      expect(dispatchSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          type: WAKE_HIBERNATED_AGENTS_WORKTREE_EVENT,
          detail: expect.objectContaining({ worktreeId: 'wt-1' })
        })
      )
      dispatchSpy.mockRestore()
    })
  })

  describe('useTabHibernation hook', () => {
    beforeEach(() => {
      useAppStore.setState(useAppStore.getInitialState(), true)
    })

    it('provides onWakeTab when tab is sleeping', () => {
      useAppStore.setState({
        ptyIdsByTabId: { 'tab-1': [] },
        sleepingAgentSessionsByPaneKey: {
          [`tab-1:${LEAF_UUID_1}`]: makeSleepingRecord()
        }
      })

      const onActivate = vi.fn()
      const { result } = renderHook(() =>
        useTabHibernation({
          open: true,
          tabId: 'tab-1',
          worktreeId: 'wt-1',
          isActive: false,
          onActivate
        })
      )

      expect(result.current.isSleeping).toBe(true)
      expect(result.current.canSleepTab).toBe(false)
      expect(result.current.onSleepTab).toBeUndefined()
      expect(result.current.onWakeTab).toBeTypeOf('function')
    })

    it('provides onSleepTab when tab is eligible to sleep', () => {
      const tab = makeTab('tab-1', 'wt-1')
      const entry = makeAgentEntry()

      useAppStore.setState({
        tabsByWorktree: { 'wt-1': [tab] },
        terminalLayoutsByTabId: {
          'tab-1': {
            activeLeafId: LEAF_UUID_1,
            expandedLeafId: null,
            root: { type: 'leaf' as const, leafId: LEAF_UUID_1 },
            ptyIdsByLeafId: { [LEAF_UUID_1]: 'pty-1' }
          }
        },
        ptyIdsByTabId: { 'tab-1': ['pty-1'] },
        agentStatusByPaneKey: { [`tab-1:${LEAF_UUID_1}`]: entry }
      })

      const onActivate = vi.fn()
      const { result } = renderHook(() =>
        useTabHibernation({
          open: true,
          tabId: 'tab-1',
          worktreeId: 'wt-1',
          isActive: false,
          onActivate
        })
      )

      expect(result.current.isSleeping).toBe(false)
      expect(result.current.canSleepTab).toBe(true)
      expect(result.current.onSleepTab).toBeTypeOf('function')
      expect(result.current.onWakeTab).toBeUndefined()
    })
  })
})
