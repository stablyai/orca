import { describe, expect, it } from 'vitest'
import {
  isPathMode,
  joinPath,
  parentPath,
  parsePathInput,
  resolveSegmentStep,
  type DirEntry
} from './remote-file-browser-entry-actions'

describe('parsePathInput', () => {
  it('preserves leading/trailing spaces in the full input', () => {
    // Path mode preserves spaces even though filter mode trims them for matching.
    const parsed = parsePathInput(' foo /bar ')
    expect(parsed).toEqual({
      mode: 'path',
      base: 'cwd',
      committedSegments: [' foo '],
      trailingFilter: 'bar '
    })
  })
})

describe('resolveSegmentStep', () => {
  it('case-sensitive exact match wins over a case-insensitive peer', () => {
    const mixed: DirEntry[] = [
      { name: 'Documents', isDirectory: true },
      { name: 'documents', isDirectory: true }
    ]
    expect(resolveSegmentStep('documents', '/home/neil', mixed)).toEqual({
      type: 'descend',
      name: 'documents'
    })
    expect(resolveSegmentStep('Documents', '/home/neil', mixed)).toEqual({
      type: 'descend',
      name: 'Documents'
    })
  })
})

describe('Windows drive paths', () => {
  it('keeps drive-shaped POSIX names in filter and child-path semantics', () => {
    expect(isPathMode('M:\\', 'posix')).toBe(false)
    expect(parsePathInput('M:\\', 'posix')).toEqual({ mode: 'filter', filter: 'M:\\' })
    expect(joinPath('/', 'M:\\', 'posix')).toBe('/M:\\')
    expect(parentPath('/M:\\', 'posix')).toBe('/')
  })

  it('parsePathInput anchors drive input at the normalized drive root', () => {
    expect(parsePathInput('m:/dev/', 'win32')).toEqual({
      mode: 'path',
      base: 'drive',
      driveRoot: 'M:\\',
      committedSegments: ['dev'],
      trailingFilter: ''
    })
    expect(parsePathInput('M:\\dev\\deb', 'win32')).toEqual({
      mode: 'path',
      base: 'drive',
      driveRoot: 'M:\\',
      committedSegments: ['dev'],
      trailingFilter: 'deb'
    })
    expect(parsePathInput('M:', 'win32')).toEqual({
      mode: 'path',
      base: 'drive',
      driveRoot: 'M:\\',
      committedSegments: [],
      trailingFilter: ''
    })
  })
})

describe('UNC paths', () => {
  it('stops at the share root when walking up', () => {
    expect(parentPath('\\\\wsl.localhost\\Ubuntu\\home\\allen', 'win32')).toBe(
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
