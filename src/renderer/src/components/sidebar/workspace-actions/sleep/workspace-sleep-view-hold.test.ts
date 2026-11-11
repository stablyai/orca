import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type Selection = { activeWorktreeId: string | null }

const store = vi.hoisted(() => {
  const listeners = new Set<(state: Selection) => void>()
  const state: Selection = { activeWorktreeId: null }
  return {
    state,
    listeners,
    select: (worktreeId: string | null): void => {
      state.activeWorktreeId = worktreeId
      for (const listener of Array.from(listeners)) {
        listener({ ...state })
      }
    }
  }
})

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => store.state,
    subscribe: (listener: (state: Selection) => void) => {
      store.listeners.add(listener)
      return () => store.listeners.delete(listener)
    }
  }
}))
vi.mock('@/lib/orca-cloud/orca-cloud-workspace-store', () => ({
  getCloudWorkspaceSnapshot: () => ({ ids: new Set<string>() })
}))

import { holdRestoredAsleepCloudSelection } from './workspace-sleep-view-hold'
import { cloudVmRecord } from './cloud-vm-record.test-fixture'
import { forgetWorktreeSleepIntent, hasWorktreeSleepIntent } from '@/lib/worktree-sleep-intent'
import { isWorktreeSleepViewHeld, resetWorktreeSleepViewForTests } from '@/lib/worktree-sleep-view'

describe('restoring an asleep Orca Cloud selection at startup (RA-13b)', () => {
  beforeEach(() => {
    store.listeners.clear()
    store.select('ws')
  })
  afterEach(() => {
    resetWorktreeSleepViewForTests()
    forgetWorktreeSleepIntent('ws')
  })

  it('keeps the selected workspace asleep and view-only when its persisted record is suspended', () => {
    // The cloud id list has not loaded yet: the record on disk alone decides.
    expect(holdRestoredAsleepCloudSelection([cloudVmRecord('ws', 'suspended')])).toBe('ws')
    expect(hasWorktreeSleepIntent('ws')).toBe(true)
    expect(isWorktreeSleepViewHeld('ws')).toBe(true)
    // Leaving it ends view-only; opening it again is the ordinary wake-on-open.
    store.select('other')
    expect(isWorktreeSleepViewHeld('ws')).toBe(false)
  })

  it('leaves a running record, a recipe VM, and an unselected workspace alone', () => {
    expect(holdRestoredAsleepCloudSelection([cloudVmRecord('ws', 'running')])).toBeNull()
    expect(holdRestoredAsleepCloudSelection([cloudVmRecord('ws', 'suspended', false)])).toBeNull()
    expect(holdRestoredAsleepCloudSelection([cloudVmRecord('other', 'suspended')])).toBeNull()
    expect(holdRestoredAsleepCloudSelection([])).toBeNull()
    expect(hasWorktreeSleepIntent('ws')).toBe(false)
    expect(isWorktreeSleepViewHeld('ws')).toBe(false)
  })
})
