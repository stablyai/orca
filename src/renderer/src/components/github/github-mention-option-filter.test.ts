import { describe, expect, it } from 'vitest'
import {
  GITHUB_MENTION_QUERY_MAX_BYTES,
  filterGitHubMentionOptions,
  isGitHubMentionQueryTooLarge,
  type GitHubMentionOption
} from './github-mention-option-filter'

function option(login: string, name: string | null = null): GitHubMentionOption {
  return { login, name }
}

describe('github-mention-option-filter', () => {
  it('filters mention options by login or display name', () => {
    const options = [
      option('octocat', 'Mona'),
      option('release-manager', 'Octavia'),
      option('build-bot')
    ]

    expect(filterGitHubMentionOptions(options, 'oct')).toEqual([options[0], options[1]])
  })

  it('caps mention options at the provided limit', () => {
    const options = [option('one'), option('two'), option('three')]

    expect(filterGitHubMentionOptions(options, '', 2)).toEqual([options[0], options[1]])
  })

  it('enforces the query budget by UTF-8 byte length', () => {
    const query = 'é'.repeat(GITHUB_MENTION_QUERY_MAX_BYTES)

    expect(query.length).toBe(GITHUB_MENTION_QUERY_MAX_BYTES)
    expect(isGitHubMentionQueryTooLarge(query)).toBe(true)
    expect(filterGitHubMentionOptions([option('octocat')], query)).toEqual([])
  })

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

    expect(isGitHubMentionQueryTooLarge(oversizedQuery)).toBe(true)
    expect(filterGitHubMentionOptions([candidate], oversizedQuery)).toEqual([])
  })
})
