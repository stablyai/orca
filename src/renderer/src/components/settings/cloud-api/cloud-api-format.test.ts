import { describe, expect, it } from 'vitest'
import { CLOUD_API_SCOPES } from '../../../../../shared/cloud-api/cloud-api-types'
import { cloudApiErrorCopy, routineRunTone } from './cloud-api-copy'
import {
  describeRoutineTrigger,
  formatCountdown,
  formatKeyPrefix,
  formatRunDuration,
  presetForScopes,
  scopesForPreset,
  timeZoneOptions
} from './cloud-api-format'

const MEMBER = CLOUD_API_SCOPES.filter((scope) => scope !== 'audit:read')

describe('scope presets', () => {
  it('read only is every read scope the viewer may grant, never admin-only ones', () => {
    expect(scopesForPreset('read', CLOUD_API_SCOPES)).toEqual([
      'workspaces:read',
      'projects:read',
      'routines:read'
    ])
    expect(scopesForPreset('full', MEMBER)).not.toContain('audit:read')
  })

  it('recognises presets from a scope list', () => {
    expect(presetForScopes(['routines:read', 'workspaces:read', 'projects:read'], MEMBER)).toBe(
      'read'
    )
    expect(presetForScopes(MEMBER, MEMBER)).toBe('full')
    expect(presetForScopes(['workspaces:read'], MEMBER)).toBe('custom')
  })
})

describe('formatting', () => {
  it('marks a key prefix as truncated', () => {
    expect(formatKeyPrefix('orca_sk_Ab3x')).toBe('orca_sk_Ab3x…')
  })

  it('formats run durations and countdowns', () => {
    expect(formatRunDuration(null)).toBe('—')
    expect(formatRunDuration(38_000)).toBe('38s')
    expect(formatRunDuration(252_000)).toBe('4m 12s')
    expect(formatRunDuration(1_800_000)).toBe('30m 00s')
    expect(formatCountdown(582_000)).toBe('9:42')
    expect(formatCountdown(-5)).toBe('0:00')
  })

  it('summarises triggers', () => {
    expect(describeRoutineTrigger({ kind: 'webhook', urlHint: null })).toBe('Webhook')
    expect(
      describeRoutineTrigger({ kind: 'github', events: ['pull_request.labeled'], labels: ['orca'] })
    ).toBe('GitHub: PR labeled “orca”')
    expect(
      describeRoutineTrigger({
        kind: 'schedule',
        cron: '0 9 * * 1-5',
        timezone: 'America/New_York'
      })
    ).toMatch(/^Weekdays at 9:00.* E[SD]T$/)
  })

  it('offers the local zone first', () => {
    const zones = timeZoneOptions('Asia/Tokyo')
    expect(zones[0]).toBe('Asia/Tokyo')
    expect(zones).toContain('UTC')
  })
})

describe('copy', () => {
  it('words every error code and keeps server detail for validation errors', () => {
    expect(cloudApiErrorCopy('admin-required')).toMatch(/owner or admin/)
    expect(
      cloudApiErrorCopy('invalid-request', undefined, { detail: 'name: Too small' })
    ).toContain('name: Too small')
    expect(cloudApiErrorCopy('rate-limited', undefined, { retryAfterSeconds: 7 })).toContain('7')
  })

  it('tones run statuses', () => {
    expect(routineRunTone('succeeded')).toBe('success')
    expect(routineRunTone('timed_out')).toBe('failure')
    expect(routineRunTone('posting')).toBe('active')
    expect(routineRunTone('cancelled')).toBe('neutral')
  })
})
