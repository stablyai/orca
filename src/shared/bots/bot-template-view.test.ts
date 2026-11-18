import { describe, expect, it } from 'vitest'
import { botTemplateMatches, freeBotName } from './bot-template-view'
import { botTemplate } from './bot-templates'

describe('the template pages', () => {
  it('names a new bot after its template, numbered when a bot already has the name', () => {
    expect(freeBotName('Pull request review', ['Atlas'])).toBe('Pull request review')
    expect(
      freeBotName('Pull request review', ['pull request review', 'Pull request review 2'])
    ).toBe('Pull request review 3')
  })

  it('finds a template by what it connects and the skills it brings', () => {
    const template = botTemplate('pr-review')!
    const label = () => 'Coding'
    expect(botTemplateMatches(template, 'github', label)).toBe(true)
    expect(botTemplateMatches(template, 'checklist', label)).toBe(true)
    expect(botTemplateMatches(template, 'slack', label)).toBe(false)
  })
})
