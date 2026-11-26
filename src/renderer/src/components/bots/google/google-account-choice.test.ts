import { describe, expect, it } from 'vitest'
import {
  googleAccountChoiceSave,
  initialGoogleAccountChoice,
  toggleGoogleAccount
} from './google-account-choice'

const accounts = [{ email: 'me@work.com' }, { email: 'me@gmail.com' }]

describe('Google account picker choice', () => {
  it('starts from what the bot has: every account for Google on with no list', () => {
    expect(initialGoogleAccountChoice({ google: true }, accounts, 'me@work.com')).toEqual([
      'me@work.com',
      'me@gmail.com'
    ])
    expect(
      initialGoogleAccountChoice(
        { google: true, googleAccounts: ['me@gmail.com'] },
        accounts,
        'me@work.com',
        'new@x.com'
      )
    ).toEqual(['me@gmail.com', 'new@x.com'])
    expect(initialGoogleAccountChoice({ google: false }, accounts, 'me@gmail.com')).toEqual([
      'me@gmail.com'
    ])
  })

  it('toggles an account, and saving with none ticked takes Google off', () => {
    const one = toggleGoogleAccount(['me@work.com'], 'Me@Gmail.com')
    expect(one).toEqual(['me@work.com', 'me@gmail.com'])
    expect(googleAccountChoiceSave(one)).toEqual({ on: true, accounts: one })
    const none = toggleGoogleAccount(toggleGoogleAccount(one, 'me@work.com'), 'me@gmail.com')
    expect(googleAccountChoiceSave(none)).toEqual({ on: false })
  })
})
