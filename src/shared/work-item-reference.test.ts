import { describe, expect, it } from 'vitest'
import { extractWorkIdentifier, stripWorkIdentifierEcho } from './work-item-reference'

describe('extractWorkIdentifier', () => {
  it('reads a GitHub pull request URL', () => {
    expect(extractWorkIdentifier('Review https://github.com/EveryInc/plugin/pull/1033')).toEqual({
      label: 'PR 1033',
      tokens: ['pr', '1033']
    })
  })

  it('reads a Bitbucket pull-requests URL', () => {
    expect(
      extractWorkIdentifier('Look at https://bitbucket.org/team/repo/pull-requests/77')?.label
    ).toBe('PR 77')
  })

  it('reads a GitLab merge request URL as MR, and a work_items URL as an issue', () => {
    expect(extractWorkIdentifier('Check https://gitlab.com/group/app/-/merge_requests/42')).toEqual(
      { label: 'MR 42', tokens: ['mr', '42'] }
    )
    expect(extractWorkIdentifier('https://gitlab.example.com/g/p/-/work_items/9')?.label).toBe(
      'Issue 9'
    )
  })

  it('reads an issue URL', () => {
    expect(extractWorkIdentifier('Fix https://github.com/o/r/issues/88')?.label).toBe('Issue 88')
  })

  it('ignores URLs whose path only resembles a work item (no owner/repo, wrong host shape)', () => {
    // A CDN asset path contains `/pull/2023` but is not a pull request.
    expect(
      extractWorkIdentifier('Load https://cdn.vendor.com/assets/pull/2023/data.json')
    ).toBeNull()
    // No trailing number after the item segment.
    expect(extractWorkIdentifier('see https://github.com/o/r/pull/notanumber')).toBeNull()
  })

  it('tolerates trailing punctuation around a URL', () => {
    expect(extractWorkIdentifier('(see https://github.com/o/r/pull/5).')?.label).toBe('PR 5')
  })

  it('reads a URL wrapped in markdown emphasis (trailing underscore/asterisk)', () => {
    expect(extractWorkIdentifier('Review _https://github.com/o/r/pull/5_ now')?.label).toBe('PR 5')
    expect(extractWorkIdentifier('Review **https://github.com/o/r/pull/1094**')?.label).toBe(
      'PR 1094'
    )
  })

  it('reads textual references', () => {
    expect(extractWorkIdentifier('please review PR #1094')?.label).toBe('PR 1094')
    expect(extractWorkIdentifier('triage pull request 500')?.label).toBe('PR 500')
    expect(extractWorkIdentifier('reproduce issue 12')?.label).toBe('Issue 12')
    expect(extractWorkIdentifier('handle merge request !9')?.label).toBe('MR 9')
  })

  it('reads a namespaced ticket id bare', () => {
    expect(extractWorkIdentifier('implement ENG-456 login flow')).toEqual({
      label: 'ENG-456',
      tokens: ['eng', '456']
    })
  })

  it('does not treat standards, ciphers, or encodings as tickets', () => {
    expect(extractWorkIdentifier('implement SHA-256 hashing')).toBeNull()
    expect(extractWorkIdentifier('parse UTF-8 input')).toBeNull()
    expect(extractWorkIdentifier('handle ISO-8601 dates')).toBeNull()
  })

  it('skips a denylisted prefix but still finds a real key after it', () => {
    expect(extractWorkIdentifier('encrypt with AES-256 for ticket ENG-99')?.label).toBe('ENG-99')
  })

  it('prefers a provider URL over an incidental ticket-shaped token', () => {
    expect(
      extractWorkIdentifier('per RFC-2616 notes, review https://github.com/o/r/pull/7')?.label
    ).toBe('PR 7')
  })

  it('falls back to a bare number, then to null', () => {
    expect(extractWorkIdentifier('look at #321 when free')?.label).toBe('#321')
    expect(extractWorkIdentifier('add a dark mode toggle to settings')).toBeNull()
  })
})

describe('stripWorkIdentifierEcho', () => {
  it('removes the identifier tokens from a description', () => {
    expect(
      stripWorkIdentifierEcho('Review this community PR', {
        label: 'PR 1094',
        tokens: ['pr', '1094']
      })
    ).toBe('Review this community')
  })

  it('removes a ticket key echoed in the description', () => {
    expect(
      stripWorkIdentifierEcho('Fix ENG 456 crash', { label: 'ENG-456', tokens: ['eng', '456'] })
    ).toBe('Fix crash')
  })
})
