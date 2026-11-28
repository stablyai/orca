import { describe, expect, it } from 'vitest'
import {
  findGitRemoteNameByFetchUrl,
  parseGitRemoteFetchUrls,
  parseGitRemoteVerboseLine
} from './git-remote-url-index'

const row = (name: string, url: string, direction: 'fetch' | 'push', filter?: string): string =>
  `${name}\t${url} (${direction})${filter ? ` [${filter}]` : ''}`

describe('git remote -v rows', () => {
  it('parses rows that carry no object filter', () => {
    expect(
      parseGitRemoteVerboseLine(row('origin', 'https://example.test/repo.git', 'fetch'))
    ).toEqual({
      name: 'origin',
      url: 'https://example.test/repo.git',
      direction: 'fetch'
    })
  })

  it('drops the partial-clone filter a row appends after the direction marker', () => {
    expect(
      parseGitRemoteVerboseLine(
        row('pr-contributor', 'https://example.test/my (fork).git', 'fetch', 'blob:none')
      )
    ).toEqual({
      name: 'pr-contributor',
      url: 'https://example.test/my (fork).git',
      direction: 'fetch'
    })
  })

  it('keeps a URL that itself ends with the annotation text', () => {
    expect(
      parseGitRemoteVerboseLine(
        row('odd', 'https://example.test/a [blob:none]', 'fetch', 'blob:none')
      )
    ).toEqual({ name: 'odd', url: 'https://example.test/a [blob:none]', direction: 'fetch' })
  })

  it('indexes and finds a remote whose fetch row carries the filter', () => {
    const stdout = [
      row('origin', 'https://example.test/repo.git', 'fetch'),
      row('pr-contributor', 'https://example.test/contributor.git', 'fetch', 'blob:none')
    ].join('\n')

    expect([...parseGitRemoteFetchUrls(stdout)]).toEqual([
      ['origin', 'https://example.test/repo.git'],
      ['pr-contributor', 'https://example.test/contributor.git']
    ])
    expect(
      findGitRemoteNameByFetchUrl(stdout, (url) => url === 'https://example.test/contributor.git')
    ).toBe('pr-contributor')
  })
})
