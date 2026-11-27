// The people list's scope as the renderer builds it: what it sends always passes the RPC's bounds.
// Synthetic names only.
import { describe, expect, it } from 'vitest'
import { BotGitHubPeople } from '../rpc-contract/bots-connector-setup-params'
import { gitHubPeopleScope } from './github-people-scope'

const repo = (fullName: string) => ({ fullName })
const tooLong = `acme/${'r'.repeat(136)}` // 141 characters

describe('the people list scope', () => {
  it('leaves out a repository name longer than GitHub allows, says it is partial, and sends', () => {
    const scope = gitHubPeopleScope([
      { accountLogin: 'acme', repositories: [repo('acme/web'), repo(tooLong), repo('acme/api')] }
    ])
    expect(scope).toEqual({ repositories: ['acme/api', 'acme/web'], owners: [], more: true })
    expect(BotGitHubPeople.safeParse({ owner: 'owner-one', scope }).success).toBe(true)
  })

  it('never lets an overlength name take one of the ten places', () => {
    const names = Array.from({ length: 10 }, (_, index) => `acme/repo-${index}`)
    // Sorted first, it would have taken a place and pushed a real one out.
    const first = `aaaa/${'r'.repeat(136)}`
    const scope = gitHubPeopleScope([
      { accountLogin: 'acme', repositories: [repo(first), ...names.map(repo)] }
    ])
    expect(scope.repositories).toEqual([...names].sort())
    expect(scope.more).toBe(true)
    expect(BotGitHubPeople.safeParse({ owner: null, scope }).success).toBe(true)
  })

  it('leaves out a whole-account install with an overlength login', () => {
    const scope = gitHubPeopleScope([
      { accountLogin: 'x'.repeat(40), repositories: null },
      { accountLogin: 'acme', repositories: null }
    ])
    expect(scope).toEqual({ repositories: [], owners: ['acme'], more: true })
    expect(BotGitHubPeople.safeParse({ owner: null, scope }).success).toBe(true)
  })

  it('keeps a name of exactly the longest length, and a scope of fitting names whole', () => {
    const longest = `acme/${'r'.repeat(135)}` // 140 characters
    const scope = gitHubPeopleScope([{ accountLogin: 'acme', repositories: [repo(longest)] }])
    expect(scope).toEqual({ repositories: [longest], owners: [], more: false })
    expect(BotGitHubPeople.safeParse({ owner: null, scope }).success).toBe(true)
  })

  it('still refuses an overlength name sent without the builder', () => {
    const scope = { repositories: [tooLong], owners: [], more: false }
    expect(BotGitHubPeople.safeParse({ owner: null, scope }).success).toBe(false)
  })
})
