import { describe, expect, it } from 'vitest'
import { resolveMacNotificationPermissionState } from '../notifications/mac-notification-permission-card'

describe('resolveMacNotificationPermissionState', () => {
  it('hides the card when notifications are unsupported', () => {
    expect(resolveMacNotificationPermissionState('unsupported', false)).toBeNull()
    expect(resolveMacNotificationPermissionState('unsupported', true)).toBeNull()
  })

  it('maps delivered probes to enabled', () => {
    expect(resolveMacNotificationPermissionState('delivered', false)).toBe('enabled')
    expect(resolveMacNotificationPermissionState('delivered', true)).toBe('enabled')
  })

  it('maps a pending authorization decision to the awaiting card', () => {
    expect(resolveMacNotificationPermissionState('awaiting-decision', false)).toBe(
      'awaiting-permission'
    )
    expect(resolveMacNotificationPermissionState('awaiting-decision', true)).toBe(
      'awaiting-permission'
    )
  })

  it('treats a first-ever rejection as an unanswered permission dialog', () => {
    expect(resolveMacNotificationPermissionState('blocked', false)).toBe('awaiting-permission')
  })

  it('treats a rejection after a prior prompt as blocked', () => {
    expect(resolveMacNotificationPermissionState('blocked', true)).toBe('blocked')
  })
})
