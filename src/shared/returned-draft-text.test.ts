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

  it('a lone conversation command gives way to the message handed back, which it could not carry', () => {
    expect(appendReturnedDraftText('/compact', 'my message')).toBe('my message')
    expect(appendReturnedDraftText(' /clear\n', 'my message')).toBe('my message')
    // Anything more than the command is the person's text, and stays.
    expect(appendReturnedDraftText('/compact now', 'my message')).toBe('/compact now\n\nmy message')
    expect(appendReturnedDraftText('a/b', 'my message')).toBe('a/b\n\nmy message')
    // A slash word that is not a conversation command is the person's text too.
    expect(appendReturnedDraftText('/clearly', 'my message')).toBe('/clearly\n\nmy message')
    expect(appendReturnedDraftText('/tmp', 'my message')).toBe('/tmp\n\nmy message')
  })
})
