import { describe, expect, it } from 'vitest'
import {
  TerminalOsc52StreamScanner,
  isTerminalOsc52ClipboardQuery
} from './terminal-osc52-stream-scanner'

describe('TerminalOsc52StreamScanner', () => {
  it('identifies clipboard queries without accepting lookalikes', () => {
    expect(isTerminalOsc52ClipboardQuery('c;?')).toBe(true)
    expect(isTerminalOsc52ClipboardQuery('c;YQ==')).toBe(false)
  })

  it('extracts and strips OSC 52 while preserving surrounding output', () => {
    const scanner = new TerminalOsc52StreamScanner()

    expect(scanner.scan('before\x1b]52;c;Y29weQ==\x07after')).toEqual({
      passthrough: 'beforeafter',
      payloads: ['c;Y29weQ==']
    })
  })

  it('tracks split ST-terminated controls across chunks', () => {
    const scanner = new TerminalOsc52StreamScanner()

    expect(scanner.scan('a\x1b]52;c;Y2')).toEqual({ passthrough: 'a', payloads: [] })
    expect(scanner.scan('9weQ==\x1b')).toEqual({ passthrough: '', payloads: [] })
    expect(scanner.scan('\\b')).toEqual({ passthrough: 'b', payloads: ['c;Y29weQ=='] })
  })

  it('restores strip state after a peer intentionally omits output', () => {
    const host = new TerminalOsc52StreamScanner()
    const client = new TerminalOsc52StreamScanner()

    host.scan('\x1b]52;c;Y2')
    client.restoreSyncState(host.syncState)

    expect(host.scan('9weQ==\x07visible').payloads).toEqual(['c;Y29weQ=='])
    expect(client.scan('9weQ==\x07visible').passthrough).toBe('visible')
  })

  it('does not release a synthetic prefix when synchronized output is not OSC 52', () => {
    const host = new TerminalOsc52StreamScanner()
    const client = new TerminalOsc52StreamScanner()

    host.scan('\x1b]5')
    client.restoreSyncState(host.syncState)

    expect(client.scan('xvisible').passthrough).toBe('xvisible')
  })

  it('supports C1 OSC and ST controls', () => {
    const scanner = new TerminalOsc52StreamScanner()

    expect(scanner.scan('\x9d52;;YQ==\x9c')).toEqual({
      passthrough: '',
      payloads: [';YQ==']
    })
  })

  it('releases non-OSC-52 controls unchanged', () => {
    const scanner = new TerminalOsc52StreamScanner()

    expect(scanner.scan('\x1b]0;title\x07text')).toEqual({
      passthrough: '\x1b]0;title\x07text',
      payloads: []
    })
  })
})
