import { describe, expect, it } from 'vitest'
import { resolvePullRequestRepo } from './github-work-item-identity'

describe('resolvePullRequestRepo', () => {
  it('routes GHES issue mutations to the API host that read the issue', () => {
    const issue = { url: 'https://github.example.com/o/r/issues/5', apiHost: 'git.example.com' }
    expect(resolvePullRequestRepo(issue)).toEqual({
      host: 'git.example.com',
      owner: 'o',
      repo: 'r'
    })
    expect(resolvePullRequestRepo({ url: issue.url })).toEqual({
      host: 'github.example.com',
      owner: 'o',
      repo: 'r'
    })
  })
})
