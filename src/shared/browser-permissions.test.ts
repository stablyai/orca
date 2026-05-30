import { describe, expect, it } from 'vitest'
import {
  getModePermissionDefaults,
  normalizePermissionOrigin,
  resolveBrowserPermissionDecision,
  shouldNotifyPermissionDenied,
  upsertSitePermissionRule
} from './browser-permissions'
import type { BrowserPermissionSettingsSnapshot } from './browser-permissions'

function settings(
  overrides: Partial<BrowserPermissionSettingsSnapshot> = {}
): BrowserPermissionSettingsSnapshot {
  return {
    browserInteractionMode: 'agent',
    browserPermissionDefaults: {},
    browserSitePermissionRules: [],
    browserPermissionNoticePolicy: 'important-only',
    ...overrides
  }
}

describe('browser permission policy', () => {
  it('uses agent-mode defaults when there are no overrides', () => {
    expect(
      resolveBrowserPermissionDecision({
        origin: 'https://example.com',
        permission: 'notifications',
        settings: settings()
      })
    ).toBe('deny')
    expect(
      resolveBrowserPermissionDecision({
        origin: 'https://example.com',
        permission: 'clipboard-read',
        settings: settings()
      })
    ).toBe('allow')
  })

  it('uses human-mode prompt defaults for common browser permissions', () => {
    expect(getModePermissionDefaults('human').notifications).toBe('prompt')
    expect(
      resolveBrowserPermissionDecision({
        origin: 'https://example.com',
        permission: 'notifications',
        settings: settings({ browserInteractionMode: 'human' })
      })
    ).toBe('prompt')
  })

  it('lets site rules override mode defaults', () => {
    expect(
      resolveBrowserPermissionDecision({
        origin: 'https://app.slack.com',
        permission: 'notifications',
        profileId: 'default',
        settings: settings({
          browserSitePermissionRules: [
            {
              profileId: 'default',
              origin: 'https://app.slack.com',
              permission: 'notifications',
              action: 'allow'
            }
          ]
        })
      })
    ).toBe('allow')
  })

  it('lets profile-scoped site rules override global permission defaults', () => {
    const snapshot = settings({
      browserPermissionDefaults: { notifications: 'deny' },
      browserSitePermissionRules: [
        {
          profileId: 'profile-1',
          origin: 'https://app.slack.com',
          permission: 'notifications',
          action: 'allow'
        }
      ]
    })

    expect(
      resolveBrowserPermissionDecision({
        origin: 'https://app.slack.com/client',
        permission: 'notifications',
        profileId: 'profile-1',
        settings: snapshot
      })
    ).toBe('allow')
    expect(
      resolveBrowserPermissionDecision({
        origin: 'https://app.slack.com/client',
        permission: 'notifications',
        profileId: 'profile-2',
        settings: snapshot
      })
    ).toBe('deny')
  })

  it('applies the safety floor to dangerous permissions', () => {
    expect(
      resolveBrowserPermissionDecision({
        origin: 'https://example.com',
        permission: 'serial',
        settings: settings({
          browserInteractionMode: 'human',
          browserPermissionDefaults: { serial: 'allow' }
        })
      })
    ).toBe('deny')
  })

  it('rejects unsupported permission names even in human mode', () => {
    expect(
      resolveBrowserPermissionDecision({
        origin: 'https://example.com',
        permission: 'serial',
        settings: settings({
          browserInteractionMode: 'human',
          browserPermissionDefaults: { serial: 'allow' }
        })
      })
    ).toBe('deny')
  })

  it('normalizes only http and https origins for site rules', () => {
    expect(normalizePermissionOrigin('https://Example.com:443/path')).toBe('https://example.com')
    expect(normalizePermissionOrigin('file:///tmp/index.html')).toBeNull()
    expect(normalizePermissionOrigin('not a url')).toBeNull()
  })

  it('does not prompt or allow trusted-origin permissions for opaque origins', () => {
    expect(
      resolveBrowserPermissionDecision({
        origin: 'data:text/html,hello',
        permission: 'media',
        settings: settings({
          browserInteractionMode: 'human',
          browserPermissionDefaults: { media: 'allow' }
        })
      })
    ).toBe('deny')
  })

  it('can upsert site rules by origin and permission', () => {
    const next = upsertSitePermissionRule(
      [
        {
          profileId: 'default',
          origin: 'https://example.com',
          permission: 'notifications',
          action: 'deny'
        }
      ],
      {
        profileId: 'default',
        origin: 'https://example.com/path',
        permission: 'notifications',
        action: 'allow'
      }
    )
    expect(next).toEqual([
      {
        profileId: 'default',
        origin: 'https://example.com',
        permission: 'notifications',
        action: 'allow'
      }
    ])
  })

  it('does not collapse remembered rules across browser profiles', () => {
    const next = upsertSitePermissionRule(
      [
        {
          profileId: 'profile-1',
          origin: 'https://example.com',
          permission: 'notifications',
          action: 'deny'
        }
      ],
      {
        profileId: 'profile-2',
        origin: 'https://example.com/path',
        permission: 'notifications',
        action: 'allow'
      }
    )

    expect(next).toEqual([
      {
        profileId: 'profile-1',
        origin: 'https://example.com',
        permission: 'notifications',
        action: 'deny'
      },
      {
        profileId: 'profile-2',
        origin: 'https://example.com',
        permission: 'notifications',
        action: 'allow'
      }
    ])
  })

  it('can remember prompt rules for a specific profile', () => {
    const next = upsertSitePermissionRule([], {
      profileId: 'profile-1',
      origin: 'https://example.com/path',
      permission: 'notifications',
      action: 'prompt'
    })

    expect(
      resolveBrowserPermissionDecision({
        origin: 'https://example.com/other',
        permission: 'notifications',
        profileId: 'profile-1',
        settings: settings({
          browserInteractionMode: 'agent',
          browserSitePermissionRules: next
        })
      })
    ).toBe('prompt')
  })

  it('suppresses low-signal notices when policy is important-only', () => {
    expect(shouldNotifyPermissionDenied('notifications', 'important-only')).toBe(true)
    expect(shouldNotifyPermissionDenied('pointerLock', 'important-only')).toBe(false)
    expect(shouldNotifyPermissionDenied('notifications', 'silent-auto-deny')).toBe(false)
  })
})
