import { describe, expect, it } from 'vitest'
import { composioAppLine } from './composio-curated-apps'

describe('an app’s one line in the bot’s app list', () => {
  it('uses a short provider summary or falls back to the app categories', () => {
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
