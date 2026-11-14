import { expect, it } from 'vitest'
import { sanitizeGeneratedConversationName } from './conversation-name-generation'

it('preserves an issue-number prefix in a generated chat name', () => {
  expect(sanitizeGeneratedConversationName('#318 — Git Broker Integration')).toBe(
    '#318 — Git Broker Integration'
  )
})
