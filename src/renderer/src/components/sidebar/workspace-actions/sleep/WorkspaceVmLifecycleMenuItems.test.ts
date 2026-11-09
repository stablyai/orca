import { describe, expect, it } from 'vitest'
import { getVmSuspendRoute, getWorkspaceVmLifecycleAction } from './WorkspaceVmLifecycleMenuItems'

describe('Suspend VM routing', () => {
  it('sleeps active child workspaces first, since they may run on this VM', () => {
    expect(getVmSuspendRoute({ hasActiveDescendants: true, hasSleepableActivity: false })).toBe(
      'sleep-subtree'
    )
    expect(getVmSuspendRoute({ hasActiveDescendants: true, hasSleepableActivity: true })).toBe(
      'sleep-subtree'
    )
  })

  it('sleeps open panels before the VM, and suspends directly when nothing is open', () => {
    expect(getVmSuspendRoute({ hasActiveDescendants: false, hasSleepableActivity: true })).toBe(
      'sleep'
    )
    expect(getVmSuspendRoute({ hasActiveDescendants: false, hasSleepableActivity: false })).toBe(
      'suspend'
    )
  })
})

describe('VM lifecycle menu item', () => {
  it('replaces Sleep only for a VM that can be suspended or resumed', () => {
    expect(getWorkspaceVmLifecycleAction(undefined, false)).toBeNull()
    expect(getWorkspaceVmLifecycleAction('running', false)).toBe('suspend')
    expect(getWorkspaceVmLifecycleAction('running', false, false)).toBeNull()
    expect(getWorkspaceVmLifecycleAction('suspended', false)).toBe('resume')
    expect(getWorkspaceVmLifecycleAction('suspended', true)).toBe('waking')
    expect(getWorkspaceVmLifecycleAction('provisioning', false)).toBeNull()
  })
})
