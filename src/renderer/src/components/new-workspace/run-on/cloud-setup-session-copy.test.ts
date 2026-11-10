import { describe, expect, it } from 'vitest'
import { translate } from '@/i18n/i18n'
import { sessionDetailCopy } from './cloud-setup-session-copy'

describe('sessionDetailCopy', () => {
  // np4-e2e: the plan row read the session's raw "subscription".
  it('never shows a setup session code on the row', () => {
    expect(
      sessionDetailCopy({ id: 'plan', state: 'done', detail: 'subscription' }, translate)
    ).toBe(null)
    expect(sessionDetailCopy({ id: 'plan', state: 'done', detail: 'trial' }, translate)).toBe(
      'Your trial covers it.'
    )
    expect(sessionDetailCopy({ id: 'plan', state: 'active', detail: 'checkout' }, translate)).toBe(
      'Finish checkout in your browser.'
    )
    expect(
      sessionDetailCopy({ id: 'github', state: 'pending', detail: 'requested' }, translate)
    ).toBe('Waiting for an owner on GitHub to approve Orca Cloud.')
  })

  it('leaves the composer’s own details alone', () => {
    expect(sessionDetailCopy({ id: 'team', state: 'done', detail: 'acme' }, translate)).toBe(
      undefined
    )
    expect(sessionDetailCopy({ id: 'github', state: 'done', detail: 'acme/web' }, translate)).toBe(
      undefined
    )
  })
})
