import { describe, expect, it } from 'vitest'
import { grantedGoogleChoices, googleSignInScopes } from './google-scopes'

const READ_DRAFT_GRANT = [
  'openid',
  'email',
  'profile',
  'https://www.googleapis.com/auth/contacts.readonly',
  'https://www.googleapis.com/auth/contacts.other.readonly',
  'https://www.googleapis.com/auth/directory.readonly',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.drafts',
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/calendar.freebusy',
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/documents.readonly',
  'https://www.googleapis.com/auth/spreadsheets.readonly'
]

describe('read-draft Google access', () => {
  it('asks Google for nothing that can send mail or change files', () => {
    expect(googleSignInScopes(['gmail', 'calendar', 'files'], 'read-draft')).toEqual(
      READ_DRAFT_GRANT
    )
  })

  it('counts a read-draft grant as covering every choice, so readiness probes them', () => {
    expect(grantedGoogleChoices(READ_DRAFT_GRANT)).toEqual(['gmail', 'calendar', 'files'])
  })
})
