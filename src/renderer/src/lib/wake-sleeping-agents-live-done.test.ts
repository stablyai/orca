// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  BACKGROUND_MOUNT_TERMINAL_WORKTREE_EVENT,
  type BackgroundMountTerminalWorktreeDetail
} from '@/constants/terminal'

const { resumeSpy, clearSleepingAgentSessionsByPaneKey } = vi.hoisted(() => ({
  resumeSpy: vi.fn(() => 0),
  clearSleepingAgentSessionsByPaneKey: vi.fn()
}))
vi.mock('./resume-sleeping-agent-session', () => ({
  resumeSleepingAgentSessionsForWorktree: resumeSpy
}))

let sleepingRecords: Record<string, Record<string, unknown>> = {}
vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({
      sleepingAgentSessionsByPaneKey: sleepingRecords,
      tabsByWorktree: {},
      clearSleepingAgentSessionsByPaneKey
    })
  }
}))

import { wakeSleepingAgentsForWorktreeInBackground } from './wake-sleeping-agents-in-background'

afterEach(() => {
  sleepingRecords = {}
  clearSleepingAgentSessionsByPaneKey.mockClear()
  resumeSpy.mockClear()
})

describe('background wake of a finished live checkpoint', () => {
  it('mounts its saved tab as passive history without launching a resume tab', () => {
    sleepingRecords = {
      'tab-done:leaf-1': {
        paneKey: 'tab-done:leaf-1',
        tabId: 'tab-done',
        worktreeId: 'wt-1',
        agent: 'codex',
        providerSession: { key: 'session_id', id: 'finished-session' },
        state: 'done',
        origin: 'live',
        capturedAt: 1,
        updatedAt: 1
      }
    }
    const mounted: BackgroundMountTerminalWorktreeDetail[] = []
    const onMount = (event: Event): void => {
      mounted.push((event as CustomEvent<BackgroundMountTerminalWorktreeDetail>).detail)
    }
    window.addEventListener(BACKGROUND_MOUNT_TERMINAL_WORKTREE_EVENT, onMount)

    try {
      wakeSleepingAgentsForWorktreeInBackground('wt-1')
    } finally {
      window.removeEventListener(BACKGROUND_MOUNT_TERMINAL_WORKTREE_EVENT, onMount)
    }

    expect(mounted).toEqual([{ worktreeId: 'wt-1', tabIds: ['tab-done'] }])
    expect(resumeSpy).toHaveBeenCalledOnce()
    expect(resumeSpy.mock.results[0]?.value).toBe(0)
  })
})
