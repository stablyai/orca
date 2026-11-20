import { describe, expect, it } from 'vitest'
import { joinPath, parentPath } from './remote-file-browser-entry-actions'

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
