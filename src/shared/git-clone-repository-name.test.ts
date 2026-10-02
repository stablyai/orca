import { describe, expect, it } from 'vitest'
import { deriveCloneRepoNameFromUrl } from './git-clone-repository-name'

describe('deriveCloneRepoNameFromUrl', () => {
  it('derives clone folder names from URLs and local paths', () => {
    expect(deriveCloneRepoNameFromUrl('https://example.com/acme/orca.git')).toBe('orca')
    expect(deriveCloneRepoNameFromUrl('git@example.com:acme/orca.git')).toBe('orca')
    expect(deriveCloneRepoNameFromUrl('C:\\src\\orca.git')).toBe('orca')
    expect(deriveCloneRepoNameFromUrl('\\\\server\\share\\orca.git')).toBe('orca')
  })

  it('rejects names that cannot be safely created inside a destination', () => {
    expect(() => deriveCloneRepoNameFromUrl('file:///tmp/source/.')).toThrow(
      'Invalid repository name derived from URL'
    )
    expect(() => deriveCloneRepoNameFromUrl('file:///tmp/source/..')).toThrow(
      'Invalid repository name derived from URL'
    )
    expect(() => deriveCloneRepoNameFromUrl('git@example.com:acme\\orca.git')).toThrow(
      'Invalid repository name derived from URL'
    )
    expect(() => deriveCloneRepoNameFromUrl('C:\\')).toThrow(
      'Invalid repository name derived from URL'
    )
  })
})
