import { expect, it } from 'vitest'
import { appendReturnedDraftText } from './returned-draft-text'

it('preserves an unsent /new command when text returns to a draft without agent identity', () => {
  expect(appendReturnedDraftText('/new', 'returned message')).toBe('/new\n\nreturned message')
})
