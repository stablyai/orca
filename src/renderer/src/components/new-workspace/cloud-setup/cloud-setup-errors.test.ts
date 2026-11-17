import { describe, expect, it } from 'vitest'
import {
  cloudSetupErrorAction,
  cloudSetupErrorTone,
  parseCloudSetupError
} from './cloud-setup-errors'

describe('parseCloudSetupError', () => {
  it('keeps known kinds and a bounded detail', () => {
    expect(parseCloudSetupError({ kind: 'bank_step' })).toEqual({ kind: 'bank_step' })
    expect(parseCloudSetupError({ kind: 'wrong_account', detail: 'sam@other.dev' })).toEqual({
      kind: 'wrong_account',
      detail: 'sam@other.dev'
    })
    expect(parseCloudSetupError({ kind: 'timed_out', detail: 'x'.repeat(321) })).toEqual({
      kind: 'timed_out'
    })
  })

  it('drops unknown kinds, `other` and junk', () => {
    for (const raw of [
      null,
      'timed_out',
      {},
      { kind: 'other' },
      { kind: 'surprise' },
      { kind: 3 }
    ]) {
      expect(parseCloudSetupError(raw)).toBeNull()
    }
  })
})

describe('setup error actions and tone', () => {
  it('gives each kind its one action', () => {
    expect(cloudSetupErrorAction('timed_out')).toBe('reopen-browser')
    expect(cloudSetupErrorAction('bank_step')).toBe('reopen-browser')
    expect(cloudSetupErrorAction('checkout_canceled')).toBe('try-again')
    expect(cloudSetupErrorAction('team_create_failed')).toBe('try-again')
    expect(cloudSetupErrorAction('trial_unavailable')).toBe('choose-plan')
    expect(cloudSetupErrorAction('wrong_account')).toBe('switch-account')
  })

  it('reads as an error only when something actually failed', () => {
    expect(cloudSetupErrorTone('team_create_failed')).toBe('error')
    expect(cloudSetupErrorTone('checkout_canceled')).toBe('neutral')
    expect(cloudSetupErrorTone('timed_out')).toBe('neutral')
  })
})
