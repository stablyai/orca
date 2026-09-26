import { describe, expect, it } from 'vitest'
import { resolveWorktreeStatus } from './worktree-status'

const base = {
  tabs: [] as never[],
  browserTabs: [] as never[],
  ptyIdsByTabId: {},
  hasPermission: false,
  hasLiveWorking: false,
  hasLiveDone: false,
  hasRetainedDone: false
}

describe('resolveWorktreeStatus — interrupted (STA-5357)', () => {
  it('reports interrupted rather than done for an interrupted agent', () => {
    expect(resolveWorktreeStatus({ ...base, hasInterrupted: true })).toBe('interrupted')
  })

  it('is never the emerald done state on its own', () => {
    expect(resolveWorktreeStatus({ ...base, hasInterrupted: true })).not.toBe('done')
  })

  it('yields to a working sibling — the live agent is the louder signal', () => {
    expect(resolveWorktreeStatus({ ...base, hasInterrupted: true, hasLiveWorking: true })).toBe(
      'working'
    )
  })

  it('yields to permission — a prompt waiting on the user is more urgent', () => {
    expect(resolveWorktreeStatus({ ...base, hasInterrupted: true, hasPermission: true })).toBe(
      'permission'
    )
  })

  it('yields to monitoring — background work is still live', () => {
    expect(resolveWorktreeStatus({ ...base, hasInterrupted: true, hasLiveMonitoring: true })).toBe(
      'monitoring'
    )
  })

  it('outranks a cleanly finished sibling', () => {
    expect(resolveWorktreeStatus({ ...base, hasInterrupted: true, hasLiveDone: true })).toBe(
      'interrupted'
    )
  })

  it('reports a failure above live work and every outcome, below only a pending question', () => {
    expect(resolveWorktreeStatus({ ...base, hasFailed: true })).toBe('failed')
    expect(resolveWorktreeStatus({ ...base, hasFailed: true, hasInterrupted: true })).toBe('failed')
    expect(resolveWorktreeStatus({ ...base, hasFailed: true, hasLiveDone: true })).toBe('failed')
    expect(resolveWorktreeStatus({ ...base, hasFailed: true, hasLiveWorking: true })).toBe('failed')
    expect(resolveWorktreeStatus({ ...base, hasFailed: true, hasLiveMonitoring: true })).toBe(
      'failed'
    )
    expect(resolveWorktreeStatus({ ...base, hasFailed: true, hasPermission: true })).toBe(
      'permission'
    )
  })

  it('leaves every other combination alone', () => {
    expect(resolveWorktreeStatus({ ...base, hasLiveDone: true })).toBe('done')
    expect(resolveWorktreeStatus({ ...base, hasLiveWorking: true })).toBe('working')
    expect(resolveWorktreeStatus({ ...base, hasLiveMonitoring: true })).toBe('monitoring')
    expect(resolveWorktreeStatus({ ...base, hasPermission: true })).toBe('permission')
  })
})
