import { describe, expect, it } from 'vitest'

import {
  createBotAuthorOverrideSet,
  filterPRCommentsByAudience,
  getPRCommentAudienceCounts,
  isBotPRComment
} from './pr-comment-audience'
import type { PRComment } from '../../../shared/types'

function comment(overrides: Partial<PRComment>): PRComment {
  return {
    id: overrides.id ?? 1,
    author: overrides.author ?? 'user',
    authorAvatarUrl: '',
    body: '',
    createdAt: '',
    url: '',
    ...overrides
  }
}

describe('pr comment audience filtering', () => {
  it('uses GitHub bot metadata before falling back to login suffixes', () => {
    expect(isBotPRComment(comment({ author: 'chatgpt-codex-connector', isBot: true }))).toBe(true)
    expect(isBotPRComment(comment({ author: 'github-actions[bot]' }))).toBe(true)
    expect(isBotPRComment(comment({ author: 'human-botany' }))).toBe(false)
  })

  it('counts and filters human and bot comments', () => {
    const comments = [
      comment({ id: 1, author: 'yasinkavakli' }),
      comment({ id: 2, author: 'chatgpt-codex-connector', isBot: true }),
      comment({ id: 3, author: 'github-actions[bot]' })
    ]

    expect(getPRCommentAudienceCounts(comments)).toEqual({ all: 3, human: 1, bot: 2 })
    expect(filterPRCommentsByAudience(comments, 'human').map((item) => item.id)).toEqual([1])
    expect(filterPRCommentsByAudience(comments, 'bot').map((item) => item.id)).toEqual([2, 3])
  })

  it('classifies manually overridden authors as bots regardless of heuristics', () => {
    const overrides = createBotAuthorOverrideSet([' GretelFlux ', '', 'other-bot-account'])

    expect(isBotPRComment(comment({ author: 'gretelflux' }))).toBe(false)
    expect(isBotPRComment(comment({ author: 'gretelflux' }), overrides)).toBe(true)
    expect(isBotPRComment(comment({ author: ' Gretelflux ' }), overrides)).toBe(true)
    expect(isBotPRComment(comment({ author: 'yasinkavakli' }), overrides)).toBe(false)
  })

  it('applies overrides to counts and filters', () => {
    const overrides = createBotAuthorOverrideSet(['gretelflux'])
    const comments = [
      comment({ id: 1, author: 'yasinkavakli' }),
      comment({ id: 2, author: 'gretelflux' }),
      comment({ id: 3, author: 'github-actions[bot]' })
    ]

    expect(getPRCommentAudienceCounts(comments, overrides)).toEqual({ all: 3, human: 1, bot: 2 })
    expect(filterPRCommentsByAudience(comments, 'human', overrides).map((item) => item.id)).toEqual(
      [1]
    )
    expect(filterPRCommentsByAudience(comments, 'bot', overrides).map((item) => item.id)).toEqual([
      2, 3
    ])
  })
})
