import { describe, expect, it } from 'vitest'
import { quoteWindowsCmdArgument } from '@orca/process-host/windows-command-line'
import { WINDOWS_ARGUMENT_CORPUS } from '../../../../packages/process-host/src/__fixtures__/windows-argument-corpus'
import {
  hasTerminalDropControlByte,
  isWindowsDoubleQuoteLiteralPath,
  quoteTerminalDropPath
} from './terminal-drop-path-quoting'

describe('hasTerminalDropControlByte', () => {
  it.each(['/repo/a\nb.txt', '/repo/a\u0015b.txt', '/repo/a\u0000b', 'C:\\a\u007fb.txt'])(
    'flags C0 controls and DEL in %j',
    (path) => {
      expect(hasTerminalDropControlByte(path)).toBe(true)
    }
  )

  it('accepts printable and non-ASCII paths', () => {
    expect(hasTerminalDropControlByte('/t/Screenshot 4.03.11\u202fPM ü.png')).toBe(false)
  })
})

describe('isWindowsDoubleQuoteLiteralPath', () => {
  it('accepts paths PowerShell, cmd and Git Bash read literally inside double quotes', () => {
    expect(isWindowsDoubleQuoteLiteralPath("C:\\My Docs\\it's a&b ^(1).txt")).toBe(true)
  })

  it.each([
    'C:\\a$b',
    'C:\\a`b',
    'C:\\a%b%',
    'C:\\a!b',
    'C:\\a"b',
    'C:\\a\u201cb',
    'C:\\a\u201db',
    'C:\\a\u201eb',
    'C:\\dir\\',
    'C:\\a\nb'
  ])('rejects %j', (path) => {
    expect(isWindowsDoubleQuoteLiteralPath(path)).toBe(false)
  })
})

describe('quoteTerminalDropPath', () => {
  it('keeps safe paths unquoted', () => {
    expect(quoteTerminalDropPath('/tmp/file.txt', 'posix')).toBe('/tmp/file.txt')
    expect(quoteTerminalDropPath('C:\\Users\\orca\\file.txt', 'powershell')).toBe(
      'C:\\Users\\orca\\file.txt'
    )
    expect(quoteTerminalDropPath('C:\\Users\\orca\\file.txt', 'cmd')).toBe(
      'C:\\Users\\orca\\file.txt'
    )
  })

  it('quotes POSIX paths in a form sh, bash, zsh and fish all read literally', () => {
    expect(quoteTerminalDropPath("/home/u/.orca/drops/my file's $draft.txt", 'posix')).toBe(
      `'/home/u/.orca/drops/my file'"'"'s $draft.txt'`
    )
    expect(quoteTerminalDropPath('/tmp/a\\b c', 'posix')).toBe(`'/tmp/a'"\\\\"'b c'`)
  })

  it('quotes Git Bash Windows paths as POSIX so backslashes survive', () => {
    expect(quoteTerminalDropPath('C:\\Users\\orca\\file.txt', 'posix')).toBe(
      `'C:'"\\\\"'Users'"\\\\"'orca'"\\\\"'file.txt'`
    )
  })

  it.each(['powershell', 'cmd'] as const)(
    'double-quotes %s paths no Windows shell expands, so a misread shell stays safe',
    (shell) => {
      expect(quoteTerminalDropPath("C:\\My Docs\\it's a&b ^(1) \u2019q\u2019.txt", shell)).toBe(
        `"C:\\My Docs\\it's a&b ^(1) \u2019q\u2019.txt"`
      )
    }
  )

  it('single-quotes PowerShell paths so $() and backticks stay literal', () => {
    expect(quoteTerminalDropPath('C:\\Users\\orca\\$(calc) `n.txt', 'powershell')).toBe(
      "'C:\\Users\\orca\\$(calc) `n.txt'"
    )
    expect(quoteTerminalDropPath("C:\\it's \u2019$x.txt", 'powershell')).toBe(
      "'C:\\it''s \u2019\u2019$x.txt'"
    )
    expect(quoteTerminalDropPath('C:\\a \u201c$(calc)\u201d.txt', 'powershell')).toBe(
      "'C:\\a \u201c$(calc)\u201d.txt'"
    )
  })

  it('keeps a trailing backslash out of a closing double quote', () => {
    expect(quoteTerminalDropPath('C:\\My Dir\\', 'powershell')).toBe("'C:\\My Dir\\'")
  })

  it('double-quotes cmd paths without carets, so separators stay literal', () => {
    expect(quoteTerminalDropPath('C:\\Users\\orca\\a&b ^(1) !x!.txt', 'cmd')).toBe(
      '"C:\\Users\\orca\\a&b ^(1) !x!.txt"'
    )
  })

  it('caret-escapes cmd percents outside the quotes so %VAR% cannot expand', () => {
    expect(quoteTerminalDropPath('C:\\a %PATH% b.txt', 'cmd')).toBe('"C:\\a "^%"PATH"^%" b.txt"')
  })

  it('doubles backslashes that precede a cmd quote so the argument parser keeps them', () => {
    expect(quoteTerminalDropPath('C:\\100\\%x', 'cmd')).toBe('"C:\\100\\\\"^%"x"')
    expect(quoteTerminalDropPath('C:\\My Dir\\', 'cmd')).toBe('"C:\\My Dir\\\\"')
  })

  // Why: that encoder's corpus round-trips through a real cmd.exe on Windows 11.
  it.each(
    WINDOWS_ARGUMENT_CORPUS.filter(
      ({ value }) =>
        quoteTerminalDropPath(value, 'cmd') !== value && !hasTerminalDropControlByte(value)
    )
  )('quotes $name for cmd exactly as the verified cmd argument encoder', ({ value }) => {
    expect(quoteTerminalDropPath(value, 'cmd')).toBe(quoteWindowsCmdArgument(value))
  })
})
