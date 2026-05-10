import { describe, expect, it } from 'vitest'
import { getDefaultCloneParent } from './clone-defaults'

describe('getDefaultCloneParent', () => {
  it('strips a POSIX workspaces suffix', () => {
    expect(getDefaultCloneParent('/Users/mvanhorn/orca/workspaces')).toBe('/Users/mvanhorn/orca')
  })

  it('strips a POSIX workspaces suffix with a trailing slash', () => {
    expect(getDefaultCloneParent('/Users/mvanhorn/orca/workspaces/')).toBe('/Users/mvanhorn/orca')
  })

  it('strips a Windows workspaces suffix', () => {
    expect(getDefaultCloneParent('C:\\Users\\mvanhorn\\orca\\workspaces')).toBe(
      'C:\\Users\\mvanhorn\\orca'
    )
  })

  it('leaves input without a workspaces suffix unchanged', () => {
    expect(getDefaultCloneParent('/Users/mvanhorn/projects')).toBe('/Users/mvanhorn/projects')
  })

  it('returns empty input unchanged', () => {
    expect(getDefaultCloneParent('')).toBe('')
  })

  it('returns an empty parent for workspaces alone', () => {
    expect(getDefaultCloneParent('workspaces')).toBe('')
  })

  it('returns root for an absolute root workspaces path', () => {
    expect(getDefaultCloneParent('/workspaces')).toBe('/')
  })

  it('returns the drive root for a Windows root workspaces path', () => {
    expect(getDefaultCloneParent('C:\\workspaces')).toBe('C:\\')
  })

  it('strips repeated trailing separators before matching the suffix', () => {
    expect(getDefaultCloneParent('D:\\orca\\workspaces\\\\')).toBe('D:\\orca')
  })

  it('does not strip a similar-looking final segment', () => {
    expect(getDefaultCloneParent('/Users/mvanhorn/orca/project-workspaces')).toBe(
      '/Users/mvanhorn/orca/project-workspaces'
    )
  })
})
