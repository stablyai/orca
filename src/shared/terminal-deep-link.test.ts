import { describe, expect, it } from 'vitest'
import {
  formatTerminalDeepLink,
  parseTerminalDeepLink,
  terminalDeepLinkFromArguments
} from './terminal-deep-link'

const HANDLE = 'term_1ef09c76-6f1b-4c3e-9d7a-0b6c2f9e4a11'

describe('parseTerminalDeepLink', () => {
  it.each([
    [`orca://terminal/${HANDLE}`, { handle: HANDLE, environment: null }],
    [`orca://terminal/${HANDLE}/`, { handle: HANDLE, environment: null }],
    [
      `orca://terminal/${HANDLE}?environment=macbook-pro-16`,
      { handle: HANDLE, environment: 'macbook-pro-16' }
    ],
    [
      `orca://terminal/${HANDLE}?environment=Studio%20Mac`,
      { handle: HANDLE, environment: 'Studio Mac' }
    ]
  ])('reads %s', (url, expected) => {
    expect(parseTerminalDeepLink(url)).toEqual(expected)
  })

  it.each([
    ['another route', `orca://worktree/${HANDLE}`],
    ['a skill share link', 'orca://skills/share/share_abc'],
    ['a pairing link', 'orca://pair?code=abc'],
    ['another scheme', `https://terminal/${HANDLE}`],
    ['a missing handle', 'orca://terminal/'],
    ['a handle without the term_ prefix', 'orca://terminal/abc'],
    ['a handle with characters handles never contain', 'orca://terminal/term_a%2Fb'],
    ['an overlong handle', `orca://terminal/term_${'a'.repeat(129)}`],
    ['extra path segments', `orca://terminal/${HANDLE}/input`],
    ['an unknown parameter', `orca://terminal/${HANDLE}?command=ls`],
    ['a repeated environment', `orca://terminal/${HANDLE}?environment=a&environment=b`],
    ['an empty environment', `orca://terminal/${HANDLE}?environment=`],
    ['an overlong environment', `orca://terminal/${HANDLE}?environment=${'a'.repeat(257)}`],
    ['a fragment', `orca://terminal/${HANDLE}#x`],
    ['credentials', `orca://user:pass@terminal/${HANDLE}`],
    ['not a URL', 'terminal switch']
  ])('rejects %s', (_case, url) => {
    expect(parseTerminalDeepLink(url)).toBeNull()
  })

  it('round-trips through the URL it formats', () => {
    const link = { handle: HANDLE, environment: 'Studio Mac & Co' }

    expect(parseTerminalDeepLink(formatTerminalDeepLink(link))).toEqual(link)
  })
})

describe('terminalDeepLinkFromArguments', () => {
  it('finds the link among launch arguments', () => {
    expect(
      terminalDeepLinkFromArguments([
        '/Applications/Orca.app',
        '--flag',
        `orca://terminal/${HANDLE}`
      ])
    ).toEqual({ handle: HANDLE, environment: null })
  })

  it('ignores arguments without a terminal link', () => {
    expect(terminalDeepLinkFromArguments(['orca', 'orca://skills/share/share_abc'])).toBeNull()
  })
})
