import { describe, expect, it } from 'vitest'
import { isWindowsUserAgent, shellEscapePath } from './pane-helpers'

describe('isWindowsUserAgent', () => {
  it('detects Windows user agents', () => {
    expect(isWindowsUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe(true)
  })

  it('ignores non-Windows user agents', () => {
    expect(isWindowsUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')).toBe(false)
  })
})

describe('shellEscapePath', () => {
  it('keeps safe POSIX paths unquoted', () => {
    expect(shellEscapePath('/tmp/file.txt', 'posix')).toBe('/tmp/file.txt')
  })

  it('single-quotes POSIX paths with shell-special characters', () => {
    expect(shellEscapePath("/tmp/it's here.txt", 'posix')).toBe("'/tmp/it'\\''s here.txt'")
  })

  it('keeps safe Windows paths unquoted', () => {
    expect(shellEscapePath('C:\\Users\\orca\\file.txt', 'windows')).toBe(
      'C:\\Users\\orca\\file.txt'
    )
  })

  it('double-quotes Windows paths with spaces', () => {
    expect(shellEscapePath('C:\\Users\\orca\\my file.txt', 'windows')).toBe(
      '"C:\\Users\\orca\\my file.txt"'
    )
  })

  it('double-quotes Windows paths with cmd separators', () => {
    expect(shellEscapePath('C:\\Users\\orca\\a&b.txt', 'windows')).toBe(
      '"C:\\Users\\orca\\a&b.txt"'
    )
  })

  it('uses POSIX escaping for SSH drops regardless of client OS', () => {
    // A Windows client dropping into a Linux SSH worktree must produce POSIX
    // quoting, not Windows double-quotes (see docs/terminal-drop-ssh.md).
    expect(shellEscapePath("/home/u/wt/.orca/drops/my file's $draft.txt", 'posix')).toBe(
      "'/home/u/wt/.orca/drops/my file'\\''s $draft.txt'"
    )
  })
})
