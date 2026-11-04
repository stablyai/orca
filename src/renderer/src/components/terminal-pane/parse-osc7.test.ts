import { describe, it, expect } from 'vitest'
import { Terminal } from '@xterm/headless'
import { OSC7_PARSER_AGREEMENT_CASES } from '../../../../shared/osc7-parser-agreement-cases'
import { parseOsc7 } from './parse-osc7'

describe('parseOsc7', () => {
  it('extracts a plain POSIX path', () => {
    expect(parseOsc7('file://host/home/jin/repo')).toBe('/home/jin/repo')
  })

  it('accepts an empty host', () => {
    expect(parseOsc7('file:///home/jin')).toBe('/home/jin')
  })

  it('percent-decodes spaces', () => {
    expect(parseOsc7('file:///home/jin/my%20code')).toBe('/home/jin/my code')
  })

  it('strips the leading slash before a Windows drive letter', () => {
    expect(parseOsc7('file:///C:/Users/jin/repo')).toBe('C:/Users/jin/repo')
  })

  it('preserves Windows UNC cwd paths', () => {
    expect(parseOsc7('file://server/share/project', { uncHost: 'server' })).toBe(
      '\\\\server\\share\\project'
    )
  })

  it('does not treat unrelated OSC-7 hosts as UNC servers', () => {
    expect(parseOsc7('file://remote/home/jin/repo', { uncHost: 'server' })).toBe('/home/jin/repo')
  })

  it('keeps POSIX host-prefixed paths unchanged by default', () => {
    expect(parseOsc7('file://server/share/project')).toBe('/share/project')
  })

  it('returns null for non-file URIs', () => {
    expect(parseOsc7('http://example.com/')).toBeNull()
  })

  it('returns null for unterminated/malformed input', () => {
    expect(parseOsc7('not a uri')).toBeNull()
    expect(parseOsc7('file://host')).toBeNull()
  })

  // The daemon's parser follows the same rules (src/shared/osc7-path-text.ts), so both agree.
  it('keeps a % not followed by two hex digits as a literal %, as nushell sends it', () => {
    expect(parseOsc7('file:///bad%ZZ')).toBe('/bad%ZZ')
    expect(parseOsc7('file://Desktop/home/me/100%')).toBe('/home/me/100%')
    expect(parseOsc7('file://Desktop/home/me/h#a?b')).toBe('/home/me/h#a?b')
  })

  it('returns null for valid hex that is not UTF-8', () => {
    expect(parseOsc7('file:///tmp/%FF')).toBeNull()
  })

  it.each(['file:///tmp/%00x', 'file:///tmp/a\u0000b'])('returns null for a NUL: %j', (uri) => {
    expect(parseOsc7(uri)).toBeNull()
  })

  it.each([
    ['file:///tmp/%01x', '/tmp/\u0001x'],
    ['file:///tmp/%0Ax', '/tmp/\nx'],
    ['file:///tmp/%1Bx', '/tmp/\u001bx'],
    ['file:///tmp/%7Fx', '/tmp/\u007fx']
  ])('keeps other control characters, which folder names may hold: %j', (uri, path) => {
    expect(parseOsc7(uri)).toBe(path)
  })
})

describe('OSC 7 payloads both parsers must agree on (renderer side)', () => {
  it.each(OSC7_PARSER_AGREEMENT_CASES)('$name, as a payload', ({ uri, folder }) => {
    expect(parseOsc7(uri)).toBe(folder)
  })

  // Real traffic: the renderer only sees what xterm's OSC parser delivers.
  it.each(OSC7_PARSER_AGREEMENT_CASES)(
    '$name, through xterm',
    async ({ uri, folder, viaXterm, xtermCancels }) => {
      const term = new Terminal({ allowProposedApi: true })
      const payloads: string[] = []
      term.parser.registerOscHandler(7, (data) => {
        payloads.push(data)
        return true
      })
      await new Promise<void>((resolve) => term.write(`\x1b]7;${uri}\x07`, resolve))
      term.dispose()
      if (xtermCancels) {
        expect(payloads).toEqual([])
        return
      }
      expect(payloads.map((data) => parseOsc7(data))).toEqual([
        viaXterm === undefined ? folder : viaXterm
      ])
    }
  )
})
