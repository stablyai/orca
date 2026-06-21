import { describe, expect, it } from 'vitest'
import { parseGitmodules } from './gitmodules-parser'

describe('parseGitmodules', () => {
  it('parses submodule names, paths, and urls', () => {
    expect(
      parseGitmodules(
        [
          '[submodule "vendor/clean"]',
          '  path = vendor/clean',
          '  url = https://example.com/clean.git',
          '',
          ' [submodule "libs/missing"]',
          ' path=libs/missing',
          '; unrelated comment',
          ' branch = main'
        ].join('\n')
      )
    ).toEqual([
      {
        name: 'vendor/clean',
        path: 'vendor/clean',
        url: 'https://example.com/clean.git'
      },
      {
        name: 'libs/missing',
        path: 'libs/missing'
      }
    ])
  })

  it('skips submodule sections without paths', () => {
    expect(
      parseGitmodules(
        ['[submodule "vendor/no-path"]', 'url = https://example.com/no-path.git'].join('\n')
      )
    ).toEqual([])
  })
})
