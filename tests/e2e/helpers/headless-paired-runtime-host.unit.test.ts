import { describe, expect, it } from 'vitest'
import {
  HeadlessPairedRuntimeStartupDiagnosticBuffer,
  formatHeadlessPairedRuntimeStartupDiagnostics
} from './headless-paired-runtime-host'

describe('headless paired runtime startup diagnostics', () => {
  it('redacts pairing URLs before truncation can remove their prefix', () => {
    const pairingUrl = `orca://${'secret'.repeat(1_500)}`
    const diagnostic = new HeadlessPairedRuntimeStartupDiagnosticBuffer()

    diagnostic.append(Buffer.from(`prefix${pairingUrl}\n`))

    expect(diagnostic.read()).toBe('prefixorca://[redacted]\n')
    expect(diagnostic.read()).not.toContain('secret')
  })

  it('redacts pairing URLs split across chunks', () => {
    const diagnostic = new HeadlessPairedRuntimeStartupDiagnosticBuffer()
    diagnostic.append(Buffer.from('orca://p'))
    diagnostic.append(Buffer.from('airing-secret\nready'))

    expect(formatHeadlessPairedRuntimeStartupDiagnostics(diagnostic.read(), '')).toBe(
      'stdout:\norca://[redacted]\nready'
    )
  })

  it('redacts encoded pairing material from web-client URLs', () => {
    const pairingUrl = encodeURIComponent('orca://pairing-secret')
    const diagnostic = new HeadlessPairedRuntimeStartupDiagnosticBuffer()

    diagnostic.append(Buffer.from(`https://host/web-index.html#pairing=${pairingUrl}\n`))

    expect(diagnostic.read()).toBe('https://host/web-index.html#pairing=[redacted]\n')
    expect(diagnostic.read()).not.toContain('pairing-secret')
  })

  it('drops oversized unfinished lines instead of retaining a pairing fragment', () => {
    const diagnostic = new HeadlessPairedRuntimeStartupDiagnosticBuffer()
    diagnostic.append(Buffer.from(`orca://${'secret'.repeat(1_500)}`))
    diagnostic.append(Buffer.from('still-secret\nsafe'))

    expect(diagnostic.read()).toBe('safe')
  })
})
