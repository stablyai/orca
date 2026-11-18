import { describe, expect, it } from 'vitest'
import { freeBotName } from './bot-template-view'

describe('the template pages', () => {
  it('names a new bot after its template, numbered when a bot already has the name', () => {
    expect(freeBotName('Pull request review', ['Atlas'])).toBe('Pull request review')
    expect(
      freeBotName('Pull request review', ['pull request review', 'Pull request review 2'])
    ).toBe('Pull request review 3')
  })
})
