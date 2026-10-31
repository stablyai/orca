import { describe, expect, it } from 'vitest'
import {
  driveBreadcrumbPath,
  driveRootOf,
  isDrivePath,
  isDriveRoot,
  joinDrivePath,
  parentOfDrivePath,
  parentOfUncPath,
  splitBrowsePath,
  uncRootOf
} from './remote-file-browser-drive-paths'
import { joinPath, parentPath } from './remote-file-browser-helpers'

describe('isDrivePath', () => {
  it('accepts drive anchors with either separator, bare colon, and any case', () => {
    expect(isDrivePath('M:\\')).toBe(true)
    expect(isDrivePath('M:/')).toBe(true)
    expect(isDrivePath('m:')).toBe(true)
    expect(isDrivePath('C:\\Users\\Administrator')).toBe(true)
  })

  it('rejects POSIX paths and ordinary filter text', () => {
    expect(isDrivePath('/home/user')).toBe(false)
    expect(isDrivePath('docs')).toBe(false)
    expect(isDrivePath('M:x')).toBe(false)
    expect(isDrivePath('12:\\')).toBe(false)
  })
})

describe('driveRootOf / isDriveRoot', () => {
  it('normalizes any drive anchor to an uppercase backslash root', () => {
    expect(driveRootOf('m:/dev')).toBe('M:\\')
    expect(driveRootOf('M:')).toBe('M:\\')
  })

  it('treats M:, M:\\ and M:/ as roots but not deeper paths', () => {
    expect(isDriveRoot('M:')).toBe(true)
    expect(isDriveRoot('M:\\')).toBe(true)
    expect(isDriveRoot('M:/')).toBe(true)
    expect(isDriveRoot('M:\\dev')).toBe(false)
  })
})

describe('splitBrowsePath', () => {
  it('splits drive paths on either separator', () => {
    expect(splitBrowsePath('M:\\dev\\debox', 'win32')).toEqual({
      kind: 'drive',
      driveRoot: 'M:\\',
      segments: ['dev', 'debox']
    })
    expect(splitBrowsePath('M:/dev', 'win32')).toEqual({
      kind: 'drive',
      driveRoot: 'M:\\',
      segments: ['dev']
    })
  })

  it('keeps POSIX paths in the POSIX shape', () => {
    expect(splitBrowsePath('/home/user')).toEqual({ kind: 'posix', segments: ['home', 'user'] })
    expect(splitBrowsePath('/')).toEqual({ kind: 'posix', segments: [] })
    expect(splitBrowsePath('M:\\dev', 'posix')).toEqual({
      kind: 'posix',
      segments: ['M:\\dev']
    })
  })
})

describe('joinDrivePath / parentOfDrivePath', () => {
  it('joins with a backslash without doubling the root separator', () => {
    expect(joinDrivePath('M:\\', 'dev')).toBe('M:\\dev')
    expect(joinDrivePath('M:\\dev', 'debox')).toBe('M:\\dev\\debox')
  })

  it('walks up to the drive root and then to the host root', () => {
    expect(parentOfDrivePath('M:\\dev\\debox')).toBe('M:\\dev')
    expect(parentOfDrivePath('M:\\dev')).toBe('M:\\')
    expect(parentOfDrivePath('M:\\')).toBe('/')
  })
})

describe('driveBreadcrumbPath', () => {
  it('rebuilds absolute paths for breadcrumb clicks', () => {
    const segments = ['dev', 'debox', 'repo']
    expect(driveBreadcrumbPath('M:\\', segments, 0)).toBe('M:\\dev')
    expect(driveBreadcrumbPath('M:\\', segments, 2)).toBe('M:\\dev\\debox\\repo')
    expect(driveBreadcrumbPath('M:\\', [], -1)).toBe('M:\\')
  })
})

describe('UNC paths', () => {
  it('anchors UNC, WSL and long-path prefixes at their share root', () => {
    expect(uncRootOf('\\\\server\\share\\dir')).toBe('\\\\server\\share\\')
    expect(uncRootOf('\\\\wsl.localhost\\Ubuntu\\home')).toBe('\\\\wsl.localhost\\Ubuntu\\')
    expect(uncRootOf('//server/share/dir')).toBe('\\\\server\\share\\')
    expect(uncRootOf('\\\\?\\UNC\\server\\share\\x')).toBe('\\\\?\\UNC\\server\\share\\')
    expect(uncRootOf('\\\\?\\C:\\Users')).toBe('\\\\?\\C:\\')
    expect(uncRootOf('\\\\wsl.localhost')).toBeNull()
    expect(uncRootOf('C:/Users/allen')).toBeNull()
    expect(uncRootOf('/home/allen')).toBeNull()
  })

  it('splits UNC paths only for the win32 flavor', () => {
    expect(splitBrowsePath('\\\\wsl.localhost\\Ubuntu\\home\\allen', 'win32')).toEqual({
      kind: 'unc',
      uncRoot: '\\\\wsl.localhost\\Ubuntu\\',
      segments: ['home', 'allen']
    })
    expect(splitBrowsePath('//server/share/dir', 'posix')).toEqual({
      kind: 'posix',
      segments: ['server', 'share', 'dir']
    })
  })

  it('stops at the share root when walking up', () => {
    expect(parentOfUncPath('\\\\wsl.localhost\\Ubuntu\\home\\allen')).toBe(
      '\\\\wsl.localhost\\Ubuntu\\home'
    )
    expect(parentPath('\\\\wsl.localhost\\Ubuntu\\home', 'win32')).toBe(
      '\\\\wsl.localhost\\Ubuntu\\'
    )
    expect(parentPath('\\\\wsl.localhost\\Ubuntu\\', 'win32')).toBe('\\\\wsl.localhost\\Ubuntu\\')
    expect(parentPath('\\\\server\\share', 'win32')).toBe('\\\\server\\share')
    expect(parentPath('\\\\server\\share\\', 'win32')).toBe('\\\\server\\share\\')
    expect(parentPath('//server/share', 'win32')).toBe('//server/share')
    expect(parentPath('\\\\?\\UNC\\server\\share', 'win32')).toBe('\\\\?\\UNC\\server\\share')
    expect(parentPath('\\\\?\\UNC\\server\\share\\dir', 'win32')).toBe(
      '\\\\?\\UNC\\server\\share\\'
    )
    expect(parentPath('\\\\?\\C:\\Users\\allen', 'win32')).toBe('\\\\?\\C:\\Users')
    expect(parentPath('\\\\?\\C:\\', 'win32')).toBe('\\\\?\\C:\\')
    expect(parentPath('\\\\?\\C:', 'win32')).toBe('\\\\?\\C:')
  })

  it('joins below a UNC root with a backslash', () => {
    expect(joinPath('\\\\wsl.localhost\\Ubuntu\\', 'home', 'win32')).toBe(
      '\\\\wsl.localhost\\Ubuntu\\home'
    )
    expect(joinPath('\\\\server\\share\\dir', 'x', 'win32')).toBe('\\\\server\\share\\dir\\x')
  })

  it('treats SSH-Windows forward-slash drive paths as drives, not POSIX or UNC', () => {
    expect(parentPath('C:/Users/allen/codes', 'win32')).toBe('C:\\Users\\allen')
    expect(parentPath('C:/', 'win32')).toBe('/')
    expect(parentPath('//server/share/dir', 'posix')).toBe('//server/share')
  })
})
