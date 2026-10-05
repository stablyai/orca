import { describe, expect, it } from 'vitest'
import {
  isProjectGroupFolderValid,
  projectGroupFolderSlug,
  resolveDefaultProjectGroupFolder
} from './project-group-folder'

describe('isProjectGroupFolderValid', () => {
  it('accepts a posix absolute path', () => {
    expect(isProjectGroupFolderValid('/Users/me/platform')).toBe(true)
  })

  it('accepts windows absolute and UNC paths', () => {
    expect(isProjectGroupFolderValid('C:\\Users\\me\\platform')).toBe(true)
    expect(isProjectGroupFolderValid('\\\\server\\share\\platform')).toBe(true)
  })

  it('rejects a relative path, which would resolve against the runtime cwd', () => {
    expect(isProjectGroupFolderValid('platform')).toBe(false)
    expect(isProjectGroupFolderValid('./platform')).toBe(false)
    expect(isProjectGroupFolderValid('../platform')).toBe(false)
  })

  it('allows clearing the folder', () => {
    expect(isProjectGroupFolderValid(null)).toBe(true)
    expect(isProjectGroupFolderValid(undefined)).toBe(true)
    expect(isProjectGroupFolderValid('')).toBe(true)
    expect(isProjectGroupFolderValid('   ')).toBe(true)
  })

  it('ignores surrounding whitespace when judging absoluteness', () => {
    expect(isProjectGroupFolderValid('  /Users/me/platform  ')).toBe(true)
    expect(isProjectGroupFolderValid('  platform  ')).toBe(false)
  })
})

describe('projectGroupFolderSlug', () => {
  it('lowercases and dash-joins, then suffixes the id', () => {
    expect(projectGroupFolderSlug('The Vocal Market', 'abcdef1234')).toBe(
      'the-vocal-market-abcdef12'
    )
  })

  it('collapses punctuation and trims edge dashes', () => {
    expect(projectGroupFolderSlug('  learnshopify.dev!  ', 'zzzzzzzz11')).toBe(
      'learnshopify-dev-zzzzzzzz'
    )
  })

  it('separates two groups that share a name', () => {
    expect(projectGroupFolderSlug('Acme', 'aaaaaaaa11')).not.toBe(
      projectGroupFolderSlug('Acme', 'bbbbbbbb22')
    )
  })

  it('falls back to the id when the name has no usable characters', () => {
    expect(projectGroupFolderSlug('***', 'idvalue99')).toBe('idvalue99')
  })

  it('caps a very long name', () => {
    expect(projectGroupFolderSlug('x'.repeat(200), 'abcdefgh12')).toBe(`${'x'.repeat(48)}-abcdefgh`)
  })
})

describe('resolveDefaultProjectGroupFolder', () => {
  it('nests the group under the managed groups directory', () => {
    expect(
      resolveDefaultProjectGroupFolder({ id: 'abcdef1234', name: 'Acme' }, '/Users/me/Orca')
    ).toBe('/Users/me/Orca/groups/acme-abcdef12')
  })

  it('tolerates a trailing separator on the root', () => {
    expect(
      resolveDefaultProjectGroupFolder({ id: 'abcdef1234', name: 'Acme' }, '/Users/me/Orca/')
    ).toBe('/Users/me/Orca/groups/acme-abcdef12')
  })

  it('honours a windows separator', () => {
    expect(
      resolveDefaultProjectGroupFolder(
        { id: 'abcdef1234', name: 'Acme' },
        'C:\\Users\\me\\Orca',
        '\\'
      )
    ).toBe('C:\\Users\\me\\Orca\\groups\\acme-abcdef12')
  })

  it('produces a path the folder validator accepts', () => {
    const path = resolveDefaultProjectGroupFolder(
      { id: 'abcdef1234', name: 'Acme' },
      '/Users/me/Orca'
    )
    expect(isProjectGroupFolderValid(path)).toBe(true)
  })
})
