import { describe, expect, it } from 'vitest'
import { createTerminalEscapeScanner } from './terminal-escape-scanner'

describe('createTerminalEscapeScanner', () => {
  it('ignores large APC/DCS/OSC control-string payloads across split ESC and ST boundaries', () => {
    const texts: string[] = []
    const csis: string[] = []
    const scanner = createTerminalEscapeScanner({
      onCsi: (privateMarker, params, final) => csis.push(`${privateMarker}${params}${final}`),
      onText: (text) => {
        if (text) {
          texts.push(text)
        }
      }
    })

    const apcPayload = 'A'.repeat(65536)
    const stream = `before\x1b[?2026h\x1b_Ga=T,f=100;${apcPayload}\x1b\\\x1b[38;5;196mafter\x1bPq#0\x1b\\!`
    for (const chunk of [
      stream.slice(0, 14),
      stream.slice(14, 17),
      stream.slice(17, 18),
      stream.slice(18, 25),
      stream.slice(25, 25 + apcPayload.length),
      stream.slice(25 + apcPayload.length, 25 + apcPayload.length + 1),
      stream.slice(25 + apcPayload.length + 1)
    ]) {
      scanner.observe(chunk)
    }

    expect(texts.join('')).toBe('beforeafter!')
    expect(csis).toEqual(['?2026h', '38;5;196m'])
  })

  it('tracks split unfinished CSI sequences across chunks', () => {
    const texts: string[] = []
    const csis: string[] = []
    const scanner = createTerminalEscapeScanner({
      onCsi: (privateMarker, params, final) => csis.push(`${privateMarker}${params}${final}`),
      onText: (text) => {
        if (text) {
          texts.push(text)
        }
      }
    })

    scanner.observe('hi\x1b[?20')
    scanner.observe('26lbye')

    expect(texts.join('')).toBe('hibye')
    expect(csis).toEqual(['?2026l'])
  })
})
