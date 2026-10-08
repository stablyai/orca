import { describe, expect, it } from 'vitest'
import { appendReturnedDraftText } from './returned-draft-text'

describe('appendReturnedDraftText', () => {
  it('fills an empty composer with the returned text as it was typed', () => {
    expect(appendReturnedDraftText('', 'ping  ')).toBe('ping  ')
    expect(appendReturnedDraftText(' \n', 'ping')).toBe('ping')
  })

  it('puts the returned text after a draft, a blank line apart', () => {
    expect(appendReturnedDraftText('newer edit\n', 'ping')).toBe('newer edit\n\nping')
  })

  it('adds nothing when the draft already ends with that text', () => {
    expect(appendReturnedDraftText('ping', 'ping')).toBe('ping')
    expect(appendReturnedDraftText('first\n\nping\n', 'ping ')).toBe('first\n\nping\n')
    expect(appendReturnedDraftText('ping', '')).toBe('ping')
  })

  it('still appends text that only ends a line of the draft', () => {
    expect(appendReturnedDraftText('say ping', 'ping')).toBe('say ping\n\nping')
  })
})
