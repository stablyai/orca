import { describe, expect, it } from 'vitest'
import {
  driveBreadcrumbPath,
  driveRootOf,
  isDrivePath,
  isDriveRoot,
  joinDrivePath,
  parentOfDrivePath,
  splitBrowsePath
} from './remote-file-browser-drive-paths'

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
