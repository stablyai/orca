import { describe, expect, it } from 'vitest'
import {
  quoteCmdDoubleQuoted,
  quotePosixShell,
  quotePosixShellDoubleQuotedApostrophe,
  quotePosixShellUnlessPlain,
  quotePosixShellUnlessPlainNoAt
} from './shell-argument-quoting'

// Verbatim bodies of the copies this module replaced, keyed by where each one lived. Every
// former copy must produce byte-identical output to the function that now serves its callers.
const sq = (value: string): string => `'${value.replace(/'/g, "'\\''")}'`
const sqAll = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`
const plainAt = (value: string): string => (/^[a-zA-Z0-9_./@:-]+$/.test(value) ? value : sq(value))
const plainNoAt = (value: string): string => (/^[A-Za-z0-9_./:-]+$/.test(value) ? value : sq(value))
const dq = (value: string): string => `'${value.replaceAll("'", `'"'"'`)}'`

const FORMER_COPIES: [string, (value: string) => string, (value: string) => string][] = [
  ['main/ssh/ssh-connection-utils shellEscape', sq, quotePosixShell],
  ['shared/wsl-login-shell-command quotePosixShell', sq, quotePosixShell],
  ['main/agent-hooks/posix-hook-command quotePosixShellString', sqAll, quotePosixShell],
  ['main/codex/codex-hook-definition inline', sqAll, quotePosixShell],
  ['main/ipc/preflight-command-exec shellQuote', sq, quotePosixShell],
  ['main/ipc/preflight-wsl-agent-detection shellQuote', sq, quotePosixShell],
  ['main/rate-limits/hidden-rate-limit-shell', sq, quotePosixShell],
  ['main/runtime/orchestration/setup-completion-signal quotePosixArg', sq, quotePosixShell],
  ['main/ssh/ssh-remote-directory-browse shellEscapeRaw', sq, quotePosixShell],
  ['shared/posix-command-path-lookup shellQuote', sq, quotePosixShell],
  ['renderer ipynb-kernel-setup-commands POSIX branch', sqAll, quotePosixShell],
  ['shared/ephemeral-vm-recipe-process POSIX branch', sq, quotePosixShell],
  ['cli/shell-command-quote POSIX tail', sqAll, quotePosixShell],
  ['main/external-editor-launch escapePosixPathForShell', plainAt, quotePosixShellUnlessPlain],
  ['renderer pane-helpers shellEscapePath POSIX', plainAt, quotePosixShellUnlessPlain],
  ['shared/setup-agent-sequencing quotePosixArg', plainNoAt, quotePosixShellUnlessPlainNoAt],
  ['shared/setup-runner-command quotePosixArg', plainNoAt, quotePosixShellUnlessPlainNoAt],
  ['main/cli/cli-install-path-format quoteShell', dq, quotePosixShellDoubleQuotedApostrophe],
  ['main/cli/wsl-cli-scripts quoteShell', dq, quotePosixShellDoubleQuotedApostrophe],
  ['main/antigravity/antigravity-browser-helper quote', dq, quotePosixShellDoubleQuotedApostrophe],
  [
    'cli/orchestration-mutation-recovery shellQuote tail',
    dq,
    quotePosixShellDoubleQuotedApostrophe
  ],
  [
    'main/linux-package-install-command quoteForPosixShell',
    (value) => `'${value.split("'").join(`'"'"'`)}'`,
    quotePosixShellDoubleQuotedApostrophe
  ],
  [
    'shared/ephemeral-vm-recipe-process win32 branch',
    (value) => `"${value.replace(/"/g, '""')}"`,
    quoteCmdDoubleQuoted
  ],
  [
    'shared/setup-runner-command quoteWindowsArg',
    (value) => `"${value.replace(/"/g, '""')}"`,
    quoteCmdDoubleQuoted
  ],
  [
    'shared/ai-vault-resume-command quoteWindowsCmdArg',
    (value) => `"${value.replace(/"/g, '""')}"`,
    quoteCmdDoubleQuoted
  ]
]

const HOSTILE_INPUTS = [
  '',
  "'",
  "''",
  "it's",
  "'; rm -rf /; '",
  'plain',
  'a@b',
  'user@host:/path',
  '/tmp/Orca Setup.deb',
  '$HOME',
  '${PATH}',
  '`id`',
  '$(id)',
  '"quoted"',
  '\\',
  'trailing\\',
  'C:\\Program Files\\Orca\\orca.exe',
  '%PATH%',
  '!x!',
  '^&|<>()',
  '~',
  '~/dir',
  '-n',
  '--flag=value',
  'a b\tc',
  'line1\nline2',
  'crlf\r\n',
  'nul\u0000byte',
  'é☃😀',
  '*?[a]{b,c}',
  '#comment',
  'a;b&&c||d'
]

describe('shell-argument-quoting matches every former copy byte for byte', () => {
  describe.each(FORMER_COPIES)('%s', (_site, former, current) => {
    it.each(HOSTILE_INPUTS)('%j', (input) => {
      expect(current(input)).toBe(former(input))
    })
  })
})

describe('quotePosixShell', () => {
  it('wraps string in single quotes', () => {
    expect(quotePosixShell('hello')).toBe("'hello'")
  })

  it('escapes embedded single quotes', () => {
    expect(quotePosixShell("it's")).toBe("'it'\\''s'")
  })

  it('handles empty string', () => {
    expect(quotePosixShell('')).toBe("''")
  })

  it('handles special characters', () => {
    expect(quotePosixShell('foo bar; rm -rf /')).toBe("'foo bar; rm -rf /'")
  })
})

describe('the spellings stay distinct', () => {
  it('spells an apostrophe two different ways', () => {
    expect(quotePosixShell("it's")).toBe(`'it'\\''s'`)
    expect(quotePosixShellDoubleQuotedApostrophe("it's")).toBe(`'it'"'"'s'`)
  })

  it('leaves @ bare only in the plain-with-@ variant', () => {
    expect(quotePosixShellUnlessPlain('a@b')).toBe('a@b')
    expect(quotePosixShellUnlessPlainNoAt('a@b')).toBe("'a@b'")
  })

  it('doubles embedded quotes for cmd.exe', () => {
    expect(quoteCmdDoubleQuoted('say "hi"')).toBe('"say ""hi"""')
  })
})
