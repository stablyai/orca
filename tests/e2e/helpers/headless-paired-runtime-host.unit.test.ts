import { describe, expect, it } from 'vitest'
import {
  HeadlessPairedRuntimeStartupDiagnosticBuffer,
  formatHeadlessPairedRuntimeStartupDiagnostics,
  parseHeadlessPairedRuntimePairingOffer
} from './headless-paired-runtime-host'

describe('headless paired runtime startup diagnostics', () => {
  it('redacts pairing URLs before truncation can remove their prefix', () => {
    const pairingUrl = `mcode://${'secret'.repeat(1_500)}`
    const diagnostic = new HeadlessPairedRuntimeStartupDiagnosticBuffer()

    diagnostic.append(Buffer.from(`prefix${pairingUrl}\n`))

    expect(diagnostic.read()).toBe('prefixmcode://[redacted]\n')
    expect(diagnostic.read()).not.toContain('secret')
  })

  it('redacts pairing URLs split across chunks', () => {
    const diagnostic = new HeadlessPairedRuntimeStartupDiagnosticBuffer()
    diagnostic.append(Buffer.from('mcode://p'))
    diagnostic.append(Buffer.from('airing-secret\nready'))

    expect(formatHeadlessPairedRuntimeStartupDiagnostics(diagnostic.read(), '')).toBe(
      'stdout:\nmcode://[redacted]\nready'
    )
  })

  it('redacts encoded pairing material from web-client URLs', () => {
    const pairingUrl = encodeURIComponent('mcode://pairing-secret')
    const diagnostic = new HeadlessPairedRuntimeStartupDiagnosticBuffer()

    diagnostic.append(Buffer.from(`https://host/web-index.html#pairing=${pairingUrl}\n`))

    expect(diagnostic.read()).toBe('https://host/web-index.html#pairing=[redacted]\n')
    expect(diagnostic.read()).not.toContain('pairing-secret')
  })

  it('drops oversized unfinished lines instead of retaining a pairing fragment', () => {
    const diagnostic = new HeadlessPairedRuntimeStartupDiagnosticBuffer()
    diagnostic.append(Buffer.from(`mcode://${'secret'.repeat(1_500)}`))
    diagnostic.append(Buffer.from('still-secret\nsafe'))

    expect(diagnostic.read()).toBe('safe')
  })
})

describe('headless paired runtime readiness', () => {
  it.each(['null', 'true', '0', '"ready"', '[]'])(
    'ignores JSON primitives and non-object readiness payloads: %s',
    (payload) => {
      expect(parseHeadlessPairedRuntimePairingOffer(payload)).toBeNull()
    }
  )

  it('accepts desktop-only pairing readiness', () => {
    expect(
      parseHeadlessPairedRuntimePairingOffer(
        JSON.stringify({
          type: 'mcode_server_ready',
          pairing: { available: true, url: 'mcode://pairing-secret', webClientUrl: null }
        })
      )
    ).toEqual({ pairingUrl: 'mcode://pairing-secret' })
  })

  it('preserves an available web-client URL', () => {
    expect(
      parseHeadlessPairedRuntimePairingOffer(
        JSON.stringify({
          type: 'mcode_server_ready',
          pairing: {
            available: true,
            url: 'mcode://pairing-secret',
            webClientUrl: 'https://example.test/web-index.html#pairing=secret'
          }
        })
      )
    ).toEqual({
      pairingUrl: 'mcode://pairing-secret',
      webClientUrl: 'https://example.test/web-index.html#pairing=secret'
    })
  })
})
