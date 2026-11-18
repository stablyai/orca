import { describe, expect, it } from 'vitest'
import { composioAppLine } from './composio-curated-apps'

describe('an app’s one line in the bot’s app list', () => {
  it('is the curated line, then Composio’s own when short, then its categories', () => {
    expect(composioAppLine('jira', [], 'A tool for bug tracking.')).toBe(
      'Issues, projects and sprints'
    )
    expect(composioAppLine('figma2', ['design'], 'A collaborative interface design tool.')).toBe(
      'A collaborative interface design tool'
    )
    expect(
      composioAppLine(
        'gmail2',
        ['email', 'ai agents'],
        'Gmail is Google’s email service, featuring spam protection, search functions, and seamless integration with other Google apps.'
      )
    ).toBe('Email and AI agents')
  })
})
