import { describe, expect, it } from 'vitest'

import { windowsLongPathGitArgs } from './windows-long-path-git-args'

describe('windowsLongPathGitArgs', () => {
  it('enables long paths for a Windows drive path', () => {
    expect(windowsLongPathGitArgs('C:\\Users\\dev\\repo', 'win32')).toEqual([
      '-c',
      'core.longpaths=true'
    ])
  })

  it.each(['darwin', 'linux'] as const)('returns nothing on %s', (platform) => {
    expect(windowsLongPathGitArgs('/home/dev/repo', platform)).toEqual([])
  })

  it.each(['\\\\wsl.localhost\\Ubuntu\\home\\dev\\repo', '\\\\wsl$\\Ubuntu\\home\\dev\\repo'])(
    'returns nothing for the WSL UNC path %s',
    (cwd) => {
      expect(windowsLongPathGitArgs(cwd, 'win32')).toEqual([])
    }
  )

  it('never mutates the shared constant', () => {
    const first = windowsLongPathGitArgs('C:\\repo', 'win32')
    first.push('--bogus')
    expect(windowsLongPathGitArgs('C:\\repo', 'win32')).toEqual(['-c', 'core.longpaths=true'])
  })
})
