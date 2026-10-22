import { describe, expect, it } from 'vitest'
import { IDLE_WORKSPACE_ACTIVITY } from './workspace-activity-facts'
import { feedSleepOverride, sleepHintHostId, isWorkspaceAsleep } from './workspace-sleep-verdict'
import type { WorkspaceLifecycleHint } from './workspace-lifecycle-hints'

const live = { ...IDLE_WORKSPACE_ACTIVITY, terminal: 'live' as const }
const sleeping: WorkspaceLifecycleHint = { kind: 'sleep', queuedBehind: 0 }

describe('isWorkspaceAsleep', () => {
  it('reads a requested sleep as asleep, and an unconfirmed one as awake', () => {
    expect(isWorkspaceAsleep({ hint: sleeping, retained: false, activity: live })).toBe(true)
    expect(
      isWorkspaceAsleep({
        hint: { ...sleeping, paused: true },
        retained: false,
        activity: undefined
      })
    ).toBe(false)
  })

  it('reads idle as asleep unless held through a rebind gap', () => {
    expect(isWorkspaceAsleep({ hint: undefined, retained: false, activity: undefined })).toBe(true)
    expect(isWorkspaceAsleep({ hint: undefined, retained: true, activity: undefined })).toBe(false)
    expect(isWorkspaceAsleep({ hint: undefined, retained: false, activity: live })).toBe(false)
    const unverifiable = { ...IDLE_WORKSPACE_ACTIVITY, terminal: 'unverifiable' as const }
    expect(isWorkspaceAsleep({ hint: undefined, retained: false, activity: unverifiable })).toBe(
      false
    )
  })
})

describe('feedSleepOverride', () => {
  it("reads only this host's copy: sleeping one host's twin never hides the other", () => {
    const twins = new Map([['ssh:box|r::/w/a', sleeping]])
    expect(feedSleepOverride(new Map(), 'r::/w/a', 'local')).toBeUndefined()
    expect(feedSleepOverride(twins, 'r::/w/a', 'ssh:box')).toBe(true)
    expect(feedSleepOverride(twins, 'r::/w/a', 'local')).toBeUndefined()
    expect(feedSleepOverride(twins, 'r::/w/a', null)).toBeUndefined()
  })

  it('reads an unconfirmed command as awake, and other commands as no override', () => {
    const paused = { kind: 'wake' as const, queuedBehind: 0, paused: true as const }
    expect(feedSleepOverride(new Map([['local|r::/w/a', paused]]), 'r::/w/a', 'local')).toBe(false)
    expect(
      feedSleepOverride(
        new Map([['local|r::/w/a', { kind: 'close' as const, queuedBehind: 0 }]]),
        'r::/w/a',
        'local'
      )
    ).toBeUndefined()
  })
})

describe('sleepHintHostId', () => {
  it("reads the row's host, else its repo's owner, else local; never a focused host", () => {
    expect(sleepHintHostId({ hostId: 'ssh:box' }, undefined)).toBe('ssh:box')
    expect(sleepHintHostId({}, { connectionId: 'box', executionHostId: undefined })).toBe('ssh:box')
    expect(sleepHintHostId({}, { connectionId: null, executionHostId: undefined })).toBe('local')
    expect(sleepHintHostId({}, undefined)).toBe('local')
  })
})
