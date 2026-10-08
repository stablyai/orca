import { describe, expect, it } from 'vitest'
import { parseTerminalDeepLink, terminalHandleFromArguments } from './terminal-deep-link'
import { parseSkillShareId } from './skill-share-link'

const UUID_HANDLE = 'term_3f2b8c1e-9d4a-4e6b-8a7c-1b2d3e4f5a6b'
const HEX_HANDLE = 'term_0123456789abcdef0123456789abcdef'

describe('parseTerminalDeepLink', () => {
  it.each([UUID_HANDLE, HEX_HANDLE])('returns the handle of orca://terminal/%s', (handle) => {
    expect(parseTerminalDeepLink(`orca://terminal/${handle}`)).toBe(handle)
    expect(parseTerminalDeepLink(`orca://terminal/${handle}/`)).toBe(handle)
  })

  it.each([
    ['wrong host', `orca://terminals/${UUID_HANDLE}`],
    ['host case variant', `orca://Terminal/${UUID_HANDLE}`],
    ['empty handle', 'orca://terminal/'],
    ['no path', 'orca://terminal'],
    ['extra segment', `orca://terminal/${UUID_HANDLE}/extra`],
    ['leading segment', `orca://terminal/x/${UUID_HANDLE}`],
    ['double trailing slash', `orca://terminal/${UUID_HANDLE}//`],
    ['query', `orca://terminal/${UUID_HANDLE}?run=1`],
    ['empty query', `orca://terminal/${UUID_HANDLE}?`],
    ['fragment', `orca://terminal/${UUID_HANDLE}#x`],
    ['userinfo', `orca://user@terminal/${UUID_HANDLE}`],
    ['port', `orca://terminal:80/${UUID_HANDLE}`],
    ['space', `orca://terminal/term_ ${HEX_HANDLE.slice(5)}`],
    ['dot segment', `orca://terminal/../terminal/${UUID_HANDLE}`],
    ['dot-dot handle', 'orca://terminal/..'],
    ['percent escape', `orca://terminal/term_%30${HEX_HANDLE.slice(6)}`],
    ['encoded slash', `orca://terminal/${UUID_HANDLE}%2F`],
    ['trailing newline', `orca://terminal/${UUID_HANDLE}\n`],
    ['embedded newline', `orca://terminal/${UUID_HANDLE}\nrm -rf ~`],
    ['leading whitespace', ` orca://terminal/${UUID_HANDLE}`],
    ['shell metacharacters', `orca://terminal/${UUID_HANDLE};id`],
    ['command substitution', 'orca://terminal/term_$(id)'],
    ['backtick', `orca://terminal/${UUID_HANDLE}\``],
    ['uppercase hex', `orca://terminal/${HEX_HANDLE.toUpperCase().replace('TERM_', 'term_')}`],
    ['over-length hex', `orca://terminal/${HEX_HANDLE}0`],
    ['short hex', `orca://terminal/${HEX_HANDLE.slice(0, -1)}`],
    ['malformed uuid', `orca://terminal/${UUID_HANDLE.replace(/-/g, '')}-`],
    ['other prefix', `orca://terminal/structworker_${HEX_HANDLE.slice(5)}`],
    ['bare handle', UUID_HANDLE],
    ['https scheme', `https://terminal/${UUID_HANDLE}`],
    ['file scheme', `file://terminal/${UUID_HANDLE}`],
    ['scheme-relative', `//terminal/${UUID_HANDLE}`],
    ['uppercase scheme', `ORCA://terminal/${UUID_HANDLE}`],
    ['single-slash form', `orca:terminal/${UUID_HANDLE}`],
    ['huge input', `orca://terminal/term_${'a'.repeat(100_000)}`]
  ])('rejects %s', (_label, value) => {
    expect(parseTerminalDeepLink(value)).toBeNull()
  })

  it('leaves the existing orca:// routes to their own parsers', () => {
    expect(parseTerminalDeepLink('orca://skills/share/share_abc')).toBeNull()
    expect(parseTerminalDeepLink('orca://pair')).toBeNull()
    expect(parseTerminalDeepLink('orca://pair?token=abc')).toBeNull()
    expect(parseSkillShareId('orca://skills/share/share_abc')).toBe('share_abc')
    expect(parseSkillShareId(`orca://terminal/${UUID_HANDLE}`)).toBeNull()
  })
})

describe('terminalHandleFromArguments', () => {
  it('finds the link among second-instance argv values', () => {
    expect(
      terminalHandleFromArguments(['/Applications/Orca', '--flag', `orca://terminal/${HEX_HANDLE}`])
    ).toBe(HEX_HANDLE)
  })

  it('ignores argv with no valid terminal link', () => {
    expect(
      terminalHandleFromArguments(['orca', 'orca://terminal/term_bad', UUID_HANDLE, '--x'])
    ).toBeNull()
  })
})
