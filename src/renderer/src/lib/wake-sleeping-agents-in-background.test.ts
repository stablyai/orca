// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  BACKGROUND_MOUNT_TERMINAL_WORKTREE_EVENT,
  WAKE_HIBERNATED_AGENTS_WORKTREE_EVENT,
  type BackgroundMountTerminalWorktreeDetail,
  type WakeHibernatedAgentsWorktreeDetail
} from '@/constants/terminal'
import { listenForHibernatedAgentWake } from '@/components/terminal-pane/hibernated-agent-wake-listener'
import type { ResumeSleepingAgentSessionsOptions } from './resume-sleeping-agent-session'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'

const resumeSpy = vi.fn<
  (worktreeId: string, options?: ResumeSleepingAgentSessionsOptions) => number
>(() => 0)
vi.mock('./resume-sleeping-agent-session', () => ({
  resumeSleepingAgentSessionsForWorktree: (
    worktreeId: string,
    options?: ResumeSleepingAgentSessionsOptions
  ) => resumeSpy(worktreeId, options)
}))

// Control passive classification directly so assertions cover wake gates, not classifier internals.
const isPassiveSpy = vi.fn()
vi.mock('./sleeping-agent-pane-ownership', () => ({
  activationTreatsNoteAsFinished: (record: unknown) => isPassiveSpy(record),
  recordPaneIsOwnedByPreservedPane: () => false,
  getProviderSessionClaimKey: (record: {
    worktreeId: string
    agent?: string
    providerSession?: { key?: string; id?: string }
  }) =>
    `${record.worktreeId}\0${record.agent ?? 'agent'}\0${record.providerSession?.key ?? 'session_id'}\0${record.providerSession?.id ?? 'session'}`
}))

let sleepingRecords: Record<string, { worktreeId: string; paneKey: string; tabId?: string }> = {}
let terminalTabsByWorktree: Record<string, { id: string }[]> = {}
const clearSleepingAgentSessionsByPaneKey = vi.fn((paneKeys: readonly string[]) => {
  for (const paneKey of paneKeys) {
    delete sleepingRecords[paneKey]
  }
})
vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({
      sleepingAgentSessionsByPaneKey: sleepingRecords,
      tabsByWorktree: terminalTabsByWorktree,
      clearSleepingAgentSessionsByPaneKey
    })
  }
}))

import {
  createBackgroundSleepingAgentWakeDispatcher,
  wakeSleepingAgentsForWorktreeInBackground
} from './wake-sleeping-agents-in-background'
import { takeSleepingAgentWakeRequest } from './sleeping-agent-wake-requests'

type RecordedEvents = {
  events: string[]
  mountDetails: BackgroundMountTerminalWorktreeDetail[]
  wakeDetails: WakeHibernatedAgentsWorktreeDetail[]
  stop: () => void
}

function recordEvents(): RecordedEvents {
  const events: string[] = []
  const mountDetails: BackgroundMountTerminalWorktreeDetail[] = []
  const wakeDetails: WakeHibernatedAgentsWorktreeDetail[] = []
  const onWake = (event: Event): void => {
    const detail = (event as CustomEvent<WakeHibernatedAgentsWorktreeDetail>).detail
    events.push(`wake:${detail.worktreeId}`)
    wakeDetails.push(detail)
  }
  const onMount = (event: Event): void => {
    const detail = (event as CustomEvent<BackgroundMountTerminalWorktreeDetail>).detail
    events.push(`mount:${detail.worktreeId}`)
    mountDetails.push(detail)
  }
  window.addEventListener(WAKE_HIBERNATED_AGENTS_WORKTREE_EVENT, onWake)
  window.addEventListener(BACKGROUND_MOUNT_TERMINAL_WORKTREE_EVENT, onMount)
  return {
    events,
    mountDetails,
    wakeDetails,
    stop: () => {
      window.removeEventListener(WAKE_HIBERNATED_AGENTS_WORKTREE_EVENT, onWake)
      window.removeEventListener(BACKGROUND_MOUNT_TERMINAL_WORKTREE_EVENT, onMount)
    }
  }
}

beforeEach(() => {
  sleepingRecords = {}
  terminalTabsByWorktree = {}
  clearSleepingAgentSessionsByPaneKey.mockClear()
  isPassiveSpy.mockReset()
  resumeSpy.mockReset()
  resumeSpy.mockReturnValue(0)
})

afterEach(() => {
  resumeSpy.mockReset()
})

describe('createBackgroundSleepingAgentWakeDispatcher', () => {
  it('deduplicates early wakes and drains them once workspace hydration completes', () => {
    let workspaceSessionReady = false
    let readinessListener: (() => void) | null = null
    const unsubscribe = vi.fn()
    const wake = vi.fn()
    const dispatcher = createBackgroundSleepingAgentWakeDispatcher({
      isWorkspaceSessionReady: () => workspaceSessionReady,
      subscribeToStore: (listener) => {
        readinessListener = listener
        return unsubscribe
      },
      wake
    })

    dispatcher.request('wt-cold')
    dispatcher.request('wt-cold')
    expect(wake).not.toHaveBeenCalled()

    workspaceSessionReady = true
    ;(readinessListener as unknown as () => void)()

    expect(unsubscribe).toHaveBeenCalledOnce()
    expect(wake).toHaveBeenCalledOnce()
    expect(wake).toHaveBeenCalledWith('wt-cold')

    dispatcher.request('wt-ready')
    expect(wake).toHaveBeenLastCalledWith('wt-ready')
    dispatcher.dispose()
  })
})

describe('wakeSleepingAgentsForWorktreeInBackground', () => {
  it('fires wake, targeted background-mount, then resume when a passive record exists', () => {
    sleepingRecords = { k1: { worktreeId: 'wt-1', paneKey: 'tab-a:leaf-1', tabId: 'tab-a' } }
    isPassiveSpy.mockReturnValue(true)
    const rec = recordEvents()

    wakeSleepingAgentsForWorktreeInBackground('wt-1')

    rec.stop()
    expect(rec.events).toEqual(['wake:wt-1', 'mount:wt-1'])
    // Target only sleeping tabs; one sleeper must not mount every saved workspace tab permanently.
    expect(rec.mountDetails[0]?.tabIds).toEqual(['tab-a'])
    expect(resumeSpy).toHaveBeenCalledWith(
      'wt-1',
      expect.objectContaining({ suppressNavigation: true })
    )
  })

  it('asks only the mounted tabs to start their agents while hidden', () => {
    const record = (tabId: string): SleepingAgentSessionRecord => ({
      paneKey: `${tabId}:leaf-1`,
      tabId,
      worktreeId: 'wt-1',
      agent: 'codex',
      providerSession: { key: 'session_id', id: `session-${tabId}` },
      prompt: '',
      state: 'done',
      capturedAt: 1,
      updatedAt: 1
    })
    const passive = record('tab-a')
    const slept = { ...record('tab-b'), restoreOnTabOpenOnly: true }
    sleepingRecords = { k1: passive, k2: slept }
    isPassiveSpy.mockReturnValue(true)

    wakeSleepingAgentsForWorktreeInBackground('wt-1')

    // Why: the background-mounted pane lands hidden, where a sleeping resume otherwise waits for a reveal.
    expect(takeSleepingAgentWakeRequest(passive)).toBe(true)
    expect(takeSleepingAgentWakeRequest(passive)).toBe(false)
    expect(takeSleepingAgentWakeRequest(slept)).toBe(false)
  })

  it('falls back to a whole-worktree mount when a passive record has no resolvable tab', () => {
    sleepingRecords = { k1: { worktreeId: 'wt-1', paneKey: 'not-a-pane-key' } }
    isPassiveSpy.mockReturnValue(true)
    const rec = recordEvents()

    wakeSleepingAgentsForWorktreeInBackground('wt-1')

    rec.stop()
    expect(rec.events).toEqual(['wake:wt-1', 'mount:wt-1'])
    expect(rec.mountDetails[0]?.tabIds).toBeUndefined()
  })

  it('mounts one canonical tab and clears cold aliases for the same provider session', () => {
    sleepingRecords = {
      'tab-a:leaf-1': {
        worktreeId: 'wt-1',
        paneKey: 'tab-a:leaf-1',
        tabId: 'tab-a',
        capturedAt: 1,
        updatedAt: 1
      } as never,
      'tab-b:leaf-1': {
        worktreeId: 'wt-1',
        paneKey: 'tab-b:leaf-1',
        tabId: 'tab-b',
        capturedAt: 2,
        updatedAt: 2
      } as never
    }
    isPassiveSpy.mockReturnValue(true)
    const rec = recordEvents()

    wakeSleepingAgentsForWorktreeInBackground('wt-1')

    rec.stop()
    expect(rec.mountDetails).toEqual([{ worktreeId: 'wt-1', tabIds: ['tab-a'] }])
    expect(clearSleepingAgentSessionsByPaneKey).toHaveBeenCalledWith(['tab-b:leaf-1'])
    expect(sleepingRecords).toHaveProperty('tab-a:leaf-1')
    expect(sleepingRecords).not.toHaveProperty('tab-b:leaf-1')
  })

  it('prefers a live duplicate tab when the oldest alias tab is gone', () => {
    sleepingRecords = {
      'missing-tab:leaf-1': {
        worktreeId: 'wt-1',
        paneKey: 'missing-tab:leaf-1',
        tabId: 'missing-tab',
        capturedAt: 1,
        updatedAt: 1
      } as never,
      'live-tab:leaf-1': {
        worktreeId: 'wt-1',
        paneKey: 'live-tab:leaf-1',
        tabId: 'live-tab',
        capturedAt: 2,
        updatedAt: 2
      } as never
    }
    terminalTabsByWorktree = { 'wt-1': [{ id: 'live-tab' }] }
    isPassiveSpy.mockReturnValue(true)
    const rec = recordEvents()

    wakeSleepingAgentsForWorktreeInBackground('wt-1')

    rec.stop()
    expect(rec.mountDetails).toEqual([{ worktreeId: 'wt-1', tabIds: ['live-tab'] }])
    expect(clearSleepingAgentSessionsByPaneKey).toHaveBeenCalledWith(['missing-tab:leaf-1'])
  })

  it('clears many cold aliases in one store action', () => {
    sleepingRecords = Object.fromEntries(
      Array.from({ length: 100 }, (_, index) => {
        const tabId = `tab-${index}`
        return [
          `${tabId}:leaf-1`,
          {
            worktreeId: 'wt-1',
            paneKey: `${tabId}:leaf-1`,
            tabId,
            capturedAt: index,
            updatedAt: index
          } as never
        ]
      })
    )
    isPassiveSpy.mockReturnValue(true)

    wakeSleepingAgentsForWorktreeInBackground('wt-1')

    expect(clearSleepingAgentSessionsByPaneKey).toHaveBeenCalledOnce()
    expect(clearSleepingAgentSessionsByPaneKey.mock.calls[0]?.[0]).toHaveLength(99)
    expect(Object.keys(sleepingRecords)).toEqual(['tab-0:leaf-1'])
  })

  it('does not background-mount finished panes captured by an explicit workspace sleep', () => {
    sleepingRecords = Object.fromEntries(
      Array.from({ length: 12 }, (_, index) => {
        const tabId = `tab-${index}`
        return [
          `${tabId}:leaf-1`,
          {
            worktreeId: 'wt-1',
            paneKey: `${tabId}:leaf-1`,
            tabId,
            capturedAt: index,
            updatedAt: index,
            providerSession: { key: 'session_id', id: `session-${index}` },
            restoreOnTabOpenOnly: true
          } as never
        ]
      })
    )
    isPassiveSpy.mockReturnValue(true)
    const rec = recordEvents()

    wakeSleepingAgentsForWorktreeInBackground('wt-1')

    rec.stop()
    // Phone workspace opens must not undo explicit agent sleep; cold-resume only when each tab opens.
    expect(rec.events).toEqual(['wake:wt-1'])
    expect(rec.mountDetails).toEqual([])
    expect(Object.keys(sleepingRecords)).toHaveLength(12)
  })

  it("wakes a workspace sleep's mounted panes, leaving the resume itself to main", () => {
    const slept: SleepingAgentSessionRecord = {
      worktreeId: 'wt-1',
      paneKey: 'tab-slept:leaf-1',
      tabId: 'tab-slept',
      agent: 'claude',
      prompt: '',
      state: 'done',
      origin: 'worktree-sleep',
      capturedAt: 1,
      updatedAt: 1,
      providerSession: { key: 'session_id', id: 'session-slept' },
      restoreOnTabOpenOnly: true
    }
    sleepingRecords = { [slept.paneKey]: slept }
    const rec = recordEvents()

    wakeSleepingAgentsForWorktreeInBackground('wt-1')

    rec.stop()
    // Why: a phone opening a slept workspace resumes its finished agents in their mounted panes.
    expect(rec.events).toEqual(['wake:wt-1'])
    expect(rec.mountDetails).toEqual([])
    expect(resumeSpy).not.toHaveBeenCalled()
  })

  it('still background-mounts hibernated panes alongside lazily restored slept panes', () => {
    sleepingRecords = {
      'tab-slept:leaf-1': {
        worktreeId: 'wt-1',
        paneKey: 'tab-slept:leaf-1',
        tabId: 'tab-slept',
        capturedAt: 1,
        updatedAt: 1,
        providerSession: { key: 'session_id', id: 'session-slept' },
        restoreOnTabOpenOnly: true
      } as never,
      'tab-hibernated:leaf-1': {
        worktreeId: 'wt-1',
        paneKey: 'tab-hibernated:leaf-1',
        tabId: 'tab-hibernated',
        capturedAt: 2,
        updatedAt: 2,
        providerSession: { key: 'session_id', id: 'session-hibernated' }
      } as never
    }
    isPassiveSpy.mockReturnValue(true)
    const rec = recordEvents()

    wakeSleepingAgentsForWorktreeInBackground('wt-1')

    rec.stop()
    expect(rec.mountDetails).toEqual([{ worktreeId: 'wt-1', tabIds: ['tab-hibernated'] }])
  })

  it('mounts the hibernated record when a lazily restored slept pane shares its claim', () => {
    sleepingRecords = {
      'tab-slept:leaf-1': {
        worktreeId: 'wt-1',
        paneKey: 'tab-slept:leaf-1',
        tabId: 'tab-slept',
        capturedAt: 1,
        updatedAt: 1,
        providerSession: { key: 'session_id', id: 'session-shared' },
        restoreOnTabOpenOnly: true
      } as never,
      'tab-hibernated:leaf-1': {
        worktreeId: 'wt-1',
        paneKey: 'tab-hibernated:leaf-1',
        tabId: 'tab-hibernated',
        capturedAt: 2,
        updatedAt: 2,
        providerSession: { key: 'session_id', id: 'session-shared' }
      } as never
    }
    isPassiveSpy.mockReturnValue(true)
    const rec = recordEvents()

    wakeSleepingAgentsForWorktreeInBackground('wt-1')

    rec.stop()
    // Filter lazy records before claim canonicalization or they can win/delete the hibernated record needing mount.
    expect(rec.mountDetails).toEqual([{ worktreeId: 'wt-1', tabIds: ['tab-hibernated'] }])
    expect(clearSleepingAgentSessionsByPaneKey).not.toHaveBeenCalledWith(['tab-hibernated:leaf-1'])
    expect(sleepingRecords).toHaveProperty('tab-hibernated:leaf-1')
    expect(sleepingRecords).toHaveProperty('tab-slept:leaf-1')
  })

  it('background-mounts the tabs the suppressed resume launches for non-passive records', () => {
    sleepingRecords = { k1: { worktreeId: 'wt-1', paneKey: 'tab-a:leaf-1', tabId: 'tab-a' } }
    isPassiveSpy.mockReturnValue(false)
    resumeSpy.mockImplementation((_worktreeId, options) => {
      options?.onSessionLaunched?.('tab-new')
      return 1
    })
    const rec = recordEvents()

    wakeSleepingAgentsForWorktreeInBackground('wt-1')

    rec.stop()
    // activate:false tabs never mount otherwise; explicit background mount must give queued --resume a PTY.
    expect(rec.events).toEqual(['wake:wt-1', 'mount:wt-1'])
    expect(rec.mountDetails[0]?.tabIds).toEqual(['tab-new'])
  })

  it('skips background-mount when only non-passive records exist and nothing launches', () => {
    sleepingRecords = { k1: { worktreeId: 'wt-1', paneKey: 'tab-a:leaf-1', tabId: 'tab-a' } }
    isPassiveSpy.mockReturnValue(false)
    const rec = recordEvents()

    wakeSleepingAgentsForWorktreeInBackground('wt-1')

    rec.stop()
    // Without passive records or new resume tabs, mounting only strands a shell and creates unnecessary work.
    expect(rec.events).toEqual(['wake:wt-1'])
    expect(resumeSpy).toHaveBeenCalledWith(
      'wt-1',
      expect.objectContaining({ suppressNavigation: true })
    )
  })

  it('wakes mounted panes through the real pane listener and skips their claims', () => {
    sleepingRecords = { k1: { worktreeId: 'wt-1', paneKey: 'tab-a:leaf-1', tabId: 'tab-a' } }
    isPassiveSpy.mockReturnValue(false)
    const wakeHibernatedAgentIfArmed = vi.fn(() => 'claim-1')
    const otherWorktreeWake = vi.fn(() => 'claim-other')
    const stopListening = listenForHibernatedAgentWake('wt-1', () => [
      { dispose: () => {}, wakeHibernatedAgentIfArmed }
    ])
    const stopOtherListening = listenForHibernatedAgentWake('wt-2', () => [
      { dispose: () => {}, wakeHibernatedAgentIfArmed: otherWorktreeWake }
    ])

    wakeSleepingAgentsForWorktreeInBackground('wt-1')

    stopListening()
    stopOtherListening()
    expect(wakeHibernatedAgentIfArmed).toHaveBeenCalledTimes(1)
    expect(otherWorktreeWake).not.toHaveBeenCalled()
    const options = resumeSpy.mock.calls[0]?.[1]
    expect(options?.skipClaimKeys?.has('claim-1')).toBe(true)
  })

  it('does nothing when the worktree has no sleeping records', () => {
    sleepingRecords = { k1: { worktreeId: 'other-wt', paneKey: 'tab-a:leaf-1' } }
    const rec = recordEvents()

    wakeSleepingAgentsForWorktreeInBackground('wt-1')

    rec.stop()
    // Mobile browsing without sleepers must not mount desktop workspaces/PTYS.
    expect(rec.events).toEqual([])
    expect(resumeSpy).not.toHaveBeenCalled()
    expect(isPassiveSpy).not.toHaveBeenCalled()
  })
})
