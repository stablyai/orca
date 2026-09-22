import { describe, expect, it } from 'vitest'
import {
  findGitRemoteNameByFetchUrl,
  parseGitRemoteFetchUrls,
  parseGitRemoteVerboseLine
} from './git-remote-url-index'

const SSH_URL = 'git@github.com:contributor/orca.git'
const HTTPS_URL = 'https://github.com/contributor/orca.git'

function verbose(rows: readonly (readonly [string, string])[]): string {
  return rows.map(([name, url]) => `${name}\t${url}`).join('\n')
}

describe('parseGitRemoteVerboseLine', () => {
  it('reads the name, URL and direction', () => {
    expect(parseGitRemoteVerboseLine(`origin\t${HTTPS_URL} (fetch)`)).toEqual({
      name: 'origin',
      url: HTTPS_URL,
      direction: 'fetch'
    })
  })

  it('keeps a URL that itself contains spaces and parentheses', () => {
    const url = '/tmp/my repo (mirror)'
    expect(parseGitRemoteVerboseLine(`local\t${url} (push)`)).toEqual({
      name: 'local',
      url,
      direction: 'push'
    })
  })

  it('rejects the URL-less row git prints for a pushurl-only remote', () => {
    expect(parseGitRemoteVerboseLine('pushonly\t')).toBeNull()
    expect(parseGitRemoteVerboseLine('not a remote row')).toBeNull()
  })
})

describe('parseGitRemoteFetchUrls', () => {
  it('returns nothing for a repo with no remotes', () => {
    expect([...parseGitRemoteFetchUrls('')]).toEqual([])
  })

  it('keeps only fetch rows, in git remote order', () => {
    const stdout = verbose([
      ['a', `${SSH_URL} (fetch)`],
      ['a', `${SSH_URL} (push)`],
      ['b', `${HTTPS_URL} (fetch)`],
      ['b', 'https://github.com/contributor/other.git (push)']
    ])
    expect([...parseGitRemoteFetchUrls(stdout)]).toEqual([
      ['a', SSH_URL],
      ['b', HTTPS_URL]
    ])
  })

  it('parses CRLF output', () => {
    const stdout = `a\t${SSH_URL} (fetch)\r\na\t${SSH_URL} (push)\r\n`
    expect([...parseGitRemoteFetchUrls(stdout)]).toEqual([['a', SSH_URL]])
  })

  it('takes the first URL of a multi-URL remote, matching remote get-url', () => {
    const stdout = verbose([
      ['multi', `${SSH_URL} (fetch)`],
      ['multi', `${SSH_URL} (push)`],
      ['multi', `${HTTPS_URL} (push)`]
    ])
    expect(parseGitRemoteFetchUrls(stdout).get('multi')).toBe(SSH_URL)
  })

  it('scales to 58 remotes without losing order', () => {
    const rows = Array.from({ length: 58 }, (_, index) => [
      `r${index}`,
      `https://example.com/o${index}/repo.git`
    ])
    const stdout = rows
      .flatMap(([name, url]) => [`${name}\t${url} (fetch)`, `${name}\t${url} (push)`])
      .join('\n')
    const parsed = [...parseGitRemoteFetchUrls(stdout)]
    expect(parsed).toHaveLength(58)
    expect(parsed[0]).toEqual(['r0', 'https://example.com/o0/repo.git'])
    expect(parsed[57]).toEqual(['r57', 'https://example.com/o57/repo.git'])
  })
})

describe('findGitRemoteNameByFetchUrl', () => {
  const stdout = verbose([
    ['origin', 'https://github.com/stablyai/orca.git (fetch)'],
    ['origin', 'https://github.com/stablyai/orca.git (push)'],
    ['first-fork', `${SSH_URL} (fetch)`],
    ['first-fork', `${SSH_URL} (push)`],
    ['second-fork', `${SSH_URL} (fetch)`],
    ['second-fork', `${SSH_URL} (push)`]
  ])

  it('returns the first remote holding a duplicated URL', () => {
    expect(findGitRemoteNameByFetchUrl(stdout, (url) => url === SSH_URL)).toBe('first-fork')
  })

  it('returns null when nothing matches', () => {
    expect(findGitRemoteNameByFetchUrl(stdout, (url) => url === HTTPS_URL)).toBeNull()
  })

  it('ignores push URLs when fetch and push differ', () => {
    const split = verbose([
      ['split', `${SSH_URL} (fetch)`],
      ['split', `${HTTPS_URL} (push)`]
    ])
    expect(findGitRemoteNameByFetchUrl(split, (url) => url === SSH_URL)).toBe('split')
    expect(findGitRemoteNameByFetchUrl(split, (url) => url === HTTPS_URL)).toBeNull()
  })
})
