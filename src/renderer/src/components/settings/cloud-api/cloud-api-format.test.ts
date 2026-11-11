import { describe, expect, it } from 'vitest'
import { CLOUD_API_SCOPES } from '../../../../../shared/cloud-api/cloud-api-types'
import {
  cloudApiErrorCopy,
  describeRoutineRunError,
  routineRunErrorCopy,
  routineRunTone
} from './cloud-api-copy'
import {
  describeRoutineTrigger,
  formatCountdown,
  formatKeyPrefix,
  formatRelativeFromNow,
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
    expect(formatKeyPrefix('orca_sk_Ab3x')).toBe('orca_sk_Ab3x••••')
  })

  it('formats run durations and countdowns', () => {
    expect(formatRunDuration(null)).toBe('—')
    expect(formatRunDuration(38_000)).toBe('38s')
    expect(formatRunDuration(252_000)).toBe('4m 12s')
    expect(formatRunDuration(1_800_000)).toBe('30m 0s')
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

  it('says "just now" for the last minute, not "this minute"', () => {
    const now = 1_000_000_000
    expect(formatRelativeFromNow(now - 3_000, now, 'en')).toBe('just now')
    expect(formatRelativeFromNow(now - 59_000, now, 'en')).toBe('just now')
    expect(formatRelativeFromNow(now - 5 * 60_000, now, 'en')).toBe('5 minutes ago')
    // Future times (next scheduled run) keep Intl wording.
    expect(formatRelativeFromNow(now + 10 * 60_000, now, 'en')).toBe('in 10 minutes')
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

describe('run failure copy', () => {
  it('maps control-plane codes (with detail) to plain words and never shows the code', () => {
    expect(routineRunErrorCopy('start_failed:clone_failed')).toBe(
      'The workspace couldn’t start, so nothing was charged.'
    )
    expect(routineRunErrorCopy('workspace_lost:suspended')).toBe(
      'The workspace went to sleep or was deleted before the run finished.'
    )
    expect(routineRunErrorCopy('post_failed')).toBe(
      'The run finished, but Orca couldn’t post the results.'
    )
    expect(routineRunErrorCopy('queue_expired')).toBe(
      'The run waited too long to start and was skipped.'
    )
    expect(routineRunErrorCopy('agent_interrupted')).toBe('Orca Cloud restarted during the run.')
    expect(routineRunErrorCopy('routine_changed')).toBe(
      'The routine changed while this run was queued.'
    )
    expect(routineRunErrorCopy('totally_new:detail')).toBe('The run failed.')
  })
})

describe('run failure tone', () => {
  it('keeps red for real failures and neutral for expected outcomes', () => {
    const tone = (code: string) => describeRoutineRunError(code).tone
    expect(['start_failed', 'post_failed', 'agent_interrupted', 'mystery'].map(tone)).toEqual([
      'error',
      'error',
      'error',
      'error'
    ])
    expect(['queue_expired', 'routine_changed', 'workspace_lost:suspended'].map(tone)).toEqual([
      'neutral',
      'neutral',
      'neutral'
    ])
  })
})
