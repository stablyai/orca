import { describe, expect, it } from 'vitest'
import type { DesktopAppAgentActivity } from '../../../../shared/desktop-app-types'
import { activityTargetsPane, type DesktopAppPaneTarget } from './desktop-app-agent-activity-match'

const NOTES_APP: DesktopAppPaneTarget = {
  windowId: 12396,
  pid: 62961,
  appName: 'Notes',
  bundleId: 'com.example.notes'
}

function activity(overrides: Partial<DesktopAppAgentActivity>): DesktopAppAgentActivity {
  return {
    phase: 'start',
    activityId: 'a1',
    method: 'computer.click',
    appSelector: null,
    pid: null,
    windowId: null,
    point: null,
    ok: null,
    at: 1_000,
    ...overrides
  }
}

describe('agent activity matching', () => {
  it('matches by pid, window id or app selector', () => {
    expect(activityTargetsPane(activity({ pid: 62961 }), NOTES_APP)).toBe(true)
    expect(activityTargetsPane(activity({ windowId: 12396 }), NOTES_APP)).toBe(true)
    expect(activityTargetsPane(activity({ appSelector: 'notes' }), NOTES_APP)).toBe(true)
    expect(activityTargetsPane(activity({ appSelector: 'com.example.notes' }), NOTES_APP)).toBe(
      true
    )
    expect(activityTargetsPane(activity({ appSelector: 'pid:62961' }), NOTES_APP)).toBe(true)
  })

  it('rejects other apps and other windows of the same app', () => {
    expect(activityTargetsPane(activity({ appSelector: 'Safari' }), NOTES_APP)).toBe(false)
    expect(activityTargetsPane(activity({ pid: 62961, windowId: 1 }), NOTES_APP)).toBe(false)
    expect(activityTargetsPane(activity({}), NOTES_APP)).toBe(false)
  })

  it('reads selectors with the native helper grammar', () => {
    expect(activityTargetsPane(activity({ appSelector: '\u0085pid:+62961 ' }), NOTES_APP)).toBe(
      true
    )
    expect(activityTargetsPane(activity({ appSelector: 'PID:62961' }), NOTES_APP)).toBe(false)
    expect(activityTargetsPane(activity({ appSelector: 'pépper' }), NOTES_APP)).toBe(false)
  })
})
