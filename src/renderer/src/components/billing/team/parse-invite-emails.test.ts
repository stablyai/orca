import { describe, expect, it } from 'vitest'
import {
  MAX_INVITES_PER_BATCH,
  mergeInviteCandidates,
  splitInviteText
} from './parse-invite-emails'

describe('splitInviteText', () => {
  it('splits commas, semicolons, newlines and spaces', () => {
    expect(splitInviteText('a@x.io, b@x.io;c@x.io\nd@x.io  e@x.io')).toEqual([
      'a@x.io',
      'b@x.io',
      'c@x.io',
      'd@x.io',
      'e@x.io'
    ])
  })

  it('keeps only the address from mail-client lines', () => {
    expect(splitInviteText('Ada Lovelace <ada@x.io>, "Grace H" <grace@x.io>')).toEqual([
      'ada@x.io',
      'grace@x.io'
    ])
  })

  it('strips mailto and wrapping punctuation', () => {
    expect(splitInviteText('mailto:a@x.io (b@x.io).')).toEqual(['a@x.io', 'b@x.io'])
  })
})

describe('mergeInviteCandidates', () => {
  it('dedupes case-insensitively and flags invalid entries', () => {
    const merged = mergeInviteCandidates([{ email: 'a@x.io', valid: true }], ['A@X.io', 'nope'])
    expect(merged).toEqual([
      { email: 'a@x.io', valid: true },
      { email: 'nope', valid: false }
    ])
  })

  it('caps a batch', () => {
    const tokens = Array.from({ length: MAX_INVITES_PER_BATCH + 5 }, (_, i) => `u${i}@x.io`)
    expect(mergeInviteCandidates([], tokens)).toHaveLength(MAX_INVITES_PER_BATCH)
  })
})
