// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  BACKGROUND_MOUNT_TERMINAL_WORKTREE_EVENT,
  WAKE_HIBERNATED_AGENTS_WORKTREE_EVENT
} from '@/constants/terminal'

const resumeSpy = vi.fn()
vi.mock('./resume-sleeping-agent-session', () => ({
  resumeSleepingAgentSessionsForWorktree: (worktreeId: string, options?: unknown) =>
    resumeSpy(worktreeId, options)
}))

// Why: control passive-vs-non-passive classification directly so the test asserts
// the gating, not the predicate internals.
const isPassiveSpy = vi.fn()
vi.mock('./sleeping-agent-pane-ownership', () => ({
  isPassiveCompletedHibernationEvidence: (record: unknown) => isPassiveSpy(record)
}))

let sleepingRecords: Record<string, { worktreeId: string }> = {}
vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({ sleepingAgentSessionsByPaneKey: sleepingRecords })
  }
}))

import { wakeSleepingAgentsForWorktreeInBackground } from './wake-sleeping-agents-in-background'

function recordEvents(): { events: string[]; stop: () => void } {
  const events: string[] = []
  const onWake = (event: Event): void => {
    events.push(`wake:${(event as CustomEvent<{ worktreeId: string }>).detail.worktreeId}`)
  }
  const onMount = (event: Event): void => {
    events.push(`mount:${(event as CustomEvent<{ worktreeId: string }>).detail.worktreeId}`)
  }
  window.addEventListener(WAKE_HIBERNATED_AGENTS_WORKTREE_EVENT, onWake)
  window.addEventListener(BACKGROUND_MOUNT_TERMINAL_WORKTREE_EVENT, onMount)
  return {
    events,
    stop: () => {
      window.removeEventListener(WAKE_HIBERNATED_AGENTS_WORKTREE_EVENT, onWake)
      window.removeEventListener(BACKGROUND_MOUNT_TERMINAL_WORKTREE_EVENT, onMount)
    }
  }
}

beforeEach(() => {
  sleepingRecords = {}
  isPassiveSpy.mockReset()
  resumeSpy.mockReset()
})

afterEach(() => {
  resumeSpy.mockReset()
})

describe('wakeSleepingAgentsForWorktreeInBackground', () => {
  it('fires wake, background-mount, then resume when a passive record exists', () => {
    sleepingRecords = { k1: { worktreeId: 'wt-1' } }
    isPassiveSpy.mockReturnValue(true)
    const rec = recordEvents()

    wakeSleepingAgentsForWorktreeInBackground('wt-1')

    rec.stop()
    // (a) pane-level wake of mounted hidden panes fires before (b) background-mount
    // of not-yet-mounted panes.
    expect(rec.events).toEqual(['wake:wt-1', 'mount:wt-1'])
    // (c) non-passive records resume with navigation suppressed (INV-2).
    expect(resumeSpy).toHaveBeenCalledWith('wt-1', { suppressNavigation: true })
  })

  it('skips background-mount when only non-passive records exist', () => {
    sleepingRecords = { k1: { worktreeId: 'wt-1' } }
    isPassiveSpy.mockReturnValue(false)
    const rec = recordEvents()

    wakeSleepingAgentsForWorktreeInBackground('wt-1')

    rec.stop()
    // Why: no passive record → no not-yet-mounted pane to fresh-connect, so
    // background-mount must not run (it would strand a plain shell / mount work).
    expect(rec.events).toEqual(['wake:wt-1'])
    expect(resumeSpy).toHaveBeenCalledWith('wt-1', { suppressNavigation: true })
  })

  it('does nothing when the worktree has no sleeping records', () => {
    sleepingRecords = { k1: { worktreeId: 'other-wt' } }
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
