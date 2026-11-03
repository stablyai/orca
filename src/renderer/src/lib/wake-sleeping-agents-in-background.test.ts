// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '@/constants/terminal'
import { listenForHibernatedAgentWake } from '@/components/terminal-pane/hibernated-agent-wake-listener'
import type { ResumeSleepingAgentSessionsOptions } from './resume-sleeping-agent-session'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session/lifecycle/agent-session-resume'

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
  isStrandedWorkspaceSleepRecord: () => false,
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
})
