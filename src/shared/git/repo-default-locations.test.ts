import { describe, expect, it } from 'vitest'
import {
  getDefaultCloneParent,
  resolveDefaultCloneDestination,
  resolveDefaultCreateProjectParent,
  resolveEffectiveLocalWorkspaceDir
} from './repo-default-locations'

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

describe('resolveEffectiveLocalWorkspaceDir', () => {
  it('uses the client workspace directory by default', () => {
    expect(resolveEffectiveLocalWorkspaceDir({ workspaceDir: '/home/li/orca/workspaces' })).toBe(
      '/home/li/orca/workspaces'
    )
  })

  it('lets a local defaultWorktreeLocation override win', () => {
    expect(
      resolveEffectiveLocalWorkspaceDir({
        workspaceDir: '/home/li/orca/workspaces',
        hostSettingOverrides: { local: { defaultWorktreeLocation: '/srv/wt' } }
      })
    ).toBe('/srv/wt')
  })

  it('falls back to empty without a workspace directory', () => {
    expect(resolveEffectiveLocalWorkspaceDir(null)).toBe('')
  })
})

describe('resolveDefaultCloneDestination', () => {
  it('derives from a configured workspace directory like the desktop clone flow', () => {
    expect(
      resolveDefaultCloneDestination({
        settings: { workspaceDir: '/home/li/orca/workspaces' },
        home: '/home/li'
      })
    ).toBe('/home/li/orca')
  })

  it('keeps a workspace directory without the workspaces suffix as-is', () => {
    expect(
      resolveDefaultCloneDestination({
        settings: { workspaceDir: '/srv/projects' },
        home: '/home/li'
      })
    ).toBe('/srv/projects')
  })

  it('falls back to the home projects directory without a workspace directory', () => {
    expect(
      resolveDefaultCloneDestination({ settings: { workspaceDir: null }, home: '/home/li' })
    ).toBe('/home/li/orca/projects')
  })

  it('falls back on an empty or whitespace workspace directory', () => {
    expect(
      resolveDefaultCloneDestination({ settings: { workspaceDir: '  ' }, home: '/home/li' })
    ).toBe('/home/li/orca/projects')
  })

  it('uses Windows separators for a Windows-style home', () => {
    expect(
      resolveDefaultCloneDestination({ settings: { workspaceDir: null }, home: 'C:\\Users\\li' })
    ).toBe('C:\\Users\\li\\orca\\projects')
  })

  it('resolves through a local defaultWorktreeLocation override', () => {
    expect(
      resolveDefaultCloneDestination({
        settings: {
          workspaceDir: '/home/li/orca/workspaces',
          hostSettingOverrides: { local: { defaultWorktreeLocation: '/srv/wt/workspaces' } }
        },
        home: '/home/li'
      })
    ).toBe('/srv/wt')
  })
})

describe('resolveDefaultCreateProjectParent', () => {
  it('uses a workspace directory the user actually chose', () => {
    expect(
      resolveDefaultCreateProjectParent({
        settings: { workspaceDir: '/srv/projects' },
        home: '/home/li'
      })
    ).toBe('/srv/projects')
  })

  it('ignores the untouched seeded default and falls back to the home projects directory', () => {
    expect(
      resolveDefaultCreateProjectParent({
        settings: { workspaceDir: '/home/li/orca/workspaces' },
        home: '/home/li'
      })
    ).toBe('/home/li/orca/projects')
  })

  it('falls back to the home projects directory without a workspace directory', () => {
    expect(resolveDefaultCreateProjectParent({ settings: {}, home: '/home/li' })).toBe(
      '/home/li/orca/projects'
    )
  })

  it('resolves through a local defaultWorktreeLocation override', () => {
    expect(
      resolveDefaultCreateProjectParent({
        settings: {
          workspaceDir: '/home/li/orca/workspaces',
          hostSettingOverrides: { local: { defaultWorktreeLocation: '/srv/wt' } }
        },
        home: '/home/li'
      })
    ).toBe('/srv/wt')
  })

  it('uses Windows separators for a Windows-style home', () => {
    expect(
      resolveDefaultCreateProjectParent({
        settings: { workspaceDir: 'C:\\Users\\li\\orca\\workspaces' },
        home: 'C:\\Users\\li'
      })
    ).toBe('C:\\Users\\li\\orca\\projects')
  })
})
