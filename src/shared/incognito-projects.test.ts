import { describe, expect, it } from 'vitest'
import {
  EMPTY_CONCEALED_REPO_IDS,
  getConcealedRepoIds,
  isIncognitoRepo,
  withoutConcealedRepos,
  withoutIncognitoRepos
} from './incognito-projects'

const repos = [{ id: 'a' }, { id: 'b', incognito: true }, { id: 'c', incognito: false }]

describe('incognito projects', () => {
  it('treats only an explicit true flag as incognito', () => {
    expect(repos.map(isIncognitoRepo)).toEqual([false, true, false])
    expect(isIncognitoRepo(undefined)).toBe(false)
  })

  it('conceals incognito repos only while locked', () => {
    expect([...getConcealedRepoIds(repos, false)]).toEqual(['b'])
    expect(getConcealedRepoIds(repos, true)).toBe(EMPTY_CONCEALED_REPO_IDS)
  })

  it('returns the shared empty set when no repo is incognito', () => {
    expect(getConcealedRepoIds([{ id: 'a' }], false)).toBe(EMPTY_CONCEALED_REPO_IDS)
  })

  it('filters concealed and incognito repos', () => {
    expect(withoutConcealedRepos(repos, new Set(['b'])).map((repo) => repo.id)).toEqual(['a', 'c'])
    expect(withoutIncognitoRepos(repos).map((repo) => repo.id)).toEqual(['a', 'c'])
  })
})
