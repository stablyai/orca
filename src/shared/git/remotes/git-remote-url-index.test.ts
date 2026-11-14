import { describe, expect, it } from 'vitest'
import { findGitRemoteNameByFetchUrl, parseGitRemoteVerboseLine } from './git-remote-url-index'

const SSH_URL = 'git@github.com:contributor/orca.git'
const HTTPS_URL = 'https://github.com/contributor/orca.git'

function verbose(rows: readonly (readonly [string, string])[]): string {
  return rows.map(([name, url]) => `${name}\t${url}`).join('\n')
}

describe('parseGitRemoteVerboseLine', () => {
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

  it('ignores push URLs when fetch and push differ', () => {
    const split = verbose([
      ['split', `${SSH_URL} (fetch)`],
      ['split', `${HTTPS_URL} (push)`]
    ])
    expect(findGitRemoteNameByFetchUrl(split, (url) => url === SSH_URL)).toBe('split')
    expect(findGitRemoteNameByFetchUrl(split, (url) => url === HTTPS_URL)).toBeNull()
  })
})
