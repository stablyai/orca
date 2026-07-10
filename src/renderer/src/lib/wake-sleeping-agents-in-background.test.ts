// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  BACKGROUND_MOUNT_TERMINAL_WORKTREE_EVENT,
  WAKE_HIBERNATED_AGENTS_WORKTREE_EVENT,
  type BackgroundMountTerminalWorktreeDetail,
  type WakeHibernatedAgentsWorktreeDetail
} from '@/constants/terminal'
import type { ResumeSleepingAgentSessionsOptions } from './resume-sleeping-agent-session'

const resumeSpy = vi.fn<
  (worktreeId: string, options?: ResumeSleepingAgentSessionsOptions) => number
>(() => 0)
vi.mock('./resume-sleeping-agent-session', () => ({
  resumeSleepingAgentSessionsForWorktree: (
    worktreeId: string,
    options?: ResumeSleepingAgentSessionsOptions
  ) => resumeSpy(worktreeId, options)
}))

// Why: control passive-vs-non-passive classification directly so the test asserts
// the gating, not the predicate internals.
const isPassiveSpy = vi.fn()
vi.mock('./sleeping-agent-pane-ownership', () => ({
  isPassiveCompletedHibernationEvidence: (record: unknown) => isPassiveSpy(record),
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
    // (a) pane-level wake of mounted hidden panes fires before (b) background-mount
    // of not-yet-mounted panes.
    expect(rec.events).toEqual(['wake:wt-1', 'mount:wt-1'])
    // Why: the mount targets only the sleeping record's tab, so one slept agent
    // does not permanently mount every saved tab in the worktree.
    expect(rec.mountDetails[0]?.tabIds).toEqual(['tab-a'])
    // (c) non-passive records resume with navigation suppressed (INV-2).
    expect(resumeSpy).toHaveBeenCalledWith(
      'wt-1',
      expect.objectContaining({ suppressNavigation: true })
    )
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
    // Why: the resume tab is created with activate:false, so nothing else
    // mounts it — without this mount the queued --resume never gets a PTY.
    expect(rec.events).toEqual(['wake:wt-1', 'mount:wt-1'])
    expect(rec.mountDetails[0]?.tabIds).toEqual(['tab-new'])
  })

  it('skips background-mount when only non-passive records exist and nothing launches', () => {
    sleepingRecords = { k1: { worktreeId: 'wt-1', paneKey: 'tab-a:leaf-1', tabId: 'tab-a' } }
    isPassiveSpy.mockReturnValue(false)
    const rec = recordEvents()

    wakeSleepingAgentsForWorktreeInBackground('wt-1')

    rec.stop()
    // Why: no passive record and no launched resume tab → nothing needs a
    // mount (it would strand a plain shell / mount work).
    expect(rec.events).toEqual(['wake:wt-1'])
    expect(resumeSpy).toHaveBeenCalledWith(
      'wt-1',
      expect.objectContaining({ suppressNavigation: true })
    )
  })

  it('passes claims consumed by mounted panes to the generic resume as skipClaimKeys', () => {
    sleepingRecords = { k1: { worktreeId: 'wt-1', paneKey: 'tab-a:leaf-1', tabId: 'tab-a' } }
    isPassiveSpy.mockReturnValue(false)
    // A mounted pane consuming the in-place wake adds its claim key to the
    // event detail — exactly what use-terminal-pane-lifecycle does.
    const onWake = (event: Event): void => {
      ;(event as CustomEvent<WakeHibernatedAgentsWorktreeDetail>).detail.wokenClaimKeys?.add(
        'claim-1'
      )
    }
    window.addEventListener(WAKE_HIBERNATED_AGENTS_WORKTREE_EVENT, onWake)

    wakeSleepingAgentsForWorktreeInBackground('wt-1')

    window.removeEventListener(WAKE_HIBERNATED_AGENTS_WORKTREE_EVENT, onWake)
    const options = resumeSpy.mock.calls[0]?.[1]
    expect(options?.skipClaimKeys?.has('claim-1')).toBe(true)
  })

  it('does nothing when the worktree has no sleeping records', () => {
    sleepingRecords = { k1: { worktreeId: 'other-wt', paneKey: 'tab-a:leaf-1' } }
    const rec = recordEvents()

    wakeSleepingAgentsForWorktreeInBackground('wt-1')

    rec.stop()
    // Why: mobile browsing a worktree with nothing slept must not mount it (and
    // its PTYs) on the desktop host.
    expect(rec.events).toEqual([])
    expect(resumeSpy).not.toHaveBeenCalled()
    expect(isPassiveSpy).not.toHaveBeenCalled()
  })
})
