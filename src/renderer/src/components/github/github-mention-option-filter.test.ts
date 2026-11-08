import { describe, expect, it } from 'vitest'
import {
  GITHUB_MENTION_QUERY_MAX_BYTES,
  filterGitHubMentionOptions,
  type GitHubMentionOption
} from './github-mention-option-filter'

describe('github-mention-option-filter', () => {
  it('rejects oversized pasted mention queries before reading option metadata', () => {
    const oversizedQuery = 'secret-mention-query'.repeat(GITHUB_MENTION_QUERY_MAX_BYTES)
    const candidate = {
      get login(): string {
        throw new Error('oversized mention queries must not scan logins')
      },
      get name(): string {
        throw new Error('oversized mention queries must not scan names')
      }
    } as GitHubMentionOption

    expect(filterGitHubMentionOptions([candidate], oversizedQuery)).toEqual([])
  })
})
