import { describe, expect, it } from 'vitest'
import { getCloneDestinationAutoFill, getDefaultCloneParent } from './clone-defaults'

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

describe('getCloneDestinationAutoFill', () => {
  it('fills the local clone destination from the workspace directory', () => {
    expect(
      getCloneDestinationAutoFill({
        step: 'clone',
        cloneDestination: '',
        activeRuntimeEnvironmentId: null,
        workspaceDir: '/Users/mvanhorn/orca/workspaces',
        cloneStepAutoFilled: false
      })
    ).toEqual({ destination: '/Users/mvanhorn/orca' })
  })

  it('waits for a workspace directory before filling', () => {
    expect(
      getCloneDestinationAutoFill({
        step: 'clone',
        cloneDestination: '',
        activeRuntimeEnvironmentId: null,
        workspaceDir: null,
        cloneStepAutoFilled: false
      })
    ).toBeNull()
  })

  it('does not overwrite typed destinations or repeat an auto-fill', () => {
    expect(
      getCloneDestinationAutoFill({
        step: 'clone',
        cloneDestination: '/tmp/project',
        activeRuntimeEnvironmentId: null,
        workspaceDir: '/Users/mvanhorn/orca/workspaces',
        cloneStepAutoFilled: false
      })
    ).toBeNull()
    expect(
      getCloneDestinationAutoFill({
        step: 'clone',
        cloneDestination: '',
        activeRuntimeEnvironmentId: null,
        workspaceDir: '/Users/mvanhorn/orca/workspaces',
        cloneStepAutoFilled: true
      })
    ).toBeNull()
  })

  it('does not fill server clone destinations for runtime environments', () => {
    expect(
      getCloneDestinationAutoFill({
        step: 'clone',
        cloneDestination: '',
        activeRuntimeEnvironmentId: 'env-local-linux',
        workspaceDir: '/Users/mvanhorn/orca/workspaces',
        cloneStepAutoFilled: false
      })
    ).toBeNull()
  })

  it('does not fill SSH clone destinations from the local workspace directory', () => {
    expect(
      getCloneDestinationAutoFill({
        step: 'clone',
        cloneDestination: '',
        activeRuntimeEnvironmentId: null,
        sshTargetId: 'openclaw-2',
        workspaceDir: '/Users/mvanhorn/orca/workspaces',
        cloneStepAutoFilled: false
      })
    ).toBeNull()
  })
})
