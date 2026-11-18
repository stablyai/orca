import { describe, expect, it, vi } from 'vitest'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, values?: Record<string, unknown>) =>
    fallback.replace(/\{\{(\w+)\}\}/g, (_m, name: string) => String(values?.[name] ?? ''))
}))

import {
  googleAccountHeadline,
  googleKeyRefusalHeadline,
  googleProblems,
  googleReadinessRows
} from './google-copy'

const account = {
  email: 'dana@example.com',
  status: 'connected' as const,
  connectedAt: 1,
  services: [
    { service: 'gmail' as const, state: 'ready' as const },
    { service: 'drive' as const, state: 'ready' as const },
    { service: 'docs' as const, state: 'needs-permission' as const },
    { service: 'sheets' as const, state: 'ready' as const },
    { service: 'contacts' as const, state: 'ready' as const }
  ]
}

describe('Google readiness rows', () => {
  it('shows Drive, Docs and Sheets as one row with its worst state', () => {
    expect(googleReadinessRows(account).map((row) => [row.label, row.readiness.state])).toEqual([
      ['Gmail', 'ready'],
      ['Drive, Docs and Sheets', 'needs-permission'],
      ['Find people by name', 'ready']
    ])
    expect(googleProblems(account)).toHaveLength(1)
  })

  it('counts the rows to fix in the headline', () => {
    expect(googleAccountHeadline(account)).toBe('Almost there: 1 things to fix')
    expect(googleAccountHeadline({ ...account, services: [account.services[0]] })).toBe(
      'Google is connected'
    )
    expect(googleAccountHeadline({ ...account, status: 'reconnect' })).toBe(
      'Google access ended. Reconnect.'
    )
  })
})

describe('a key refusal beside the checklist', () => {
  it('keeps only what was wrong', () => {
    expect(
      googleKeyRefusalHeadline(
        'This is a Web app client. Choose a Desktop app client. In Google Cloud Console, open Credentials (x), then download its file.'
      )
    ).toBe('This is a Web app client. Choose a Desktop app client.')
    expect(googleKeyRefusalHeadline('Something else.')).toBe('Something else.')
  })
})
