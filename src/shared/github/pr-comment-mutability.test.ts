import { describe, expect, it } from 'vitest'
import { isMutablePRConversationComment } from './pr-comment-mutability'

describe('isMutablePRConversationComment', () => {
  it('allows top-level conversation comments but not review threads or summaries', () => {
    expect(
      isMutablePRConversationComment({
        id: 12,
        url: 'https://github.com/acme/widgets/pull/42#issuecomment-12'
      })
    ).toBe(true)
    expect(
      isMutablePRConversationComment({
        id: 34,
        url: 'https://github.com/acme/widgets/pull/42#discussion_r34',
        threadId: 'thread-1',
        path: 'src/a.ts'
      })
    ).toBe(false)
    expect(
      isMutablePRConversationComment({
        id: 99,
        url: 'https://github.com/acme/widgets/pull/42#pullrequestreview-99'
      })
    ).toBe(false)
  })
})
