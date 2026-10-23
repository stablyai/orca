import { X509Certificate } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import * as tls from 'node:tls'
import { afterEach, describe, expect, it } from 'vitest'
import {
  isDistrustedTlsCertificate,
  removeDistrustedRootsFromDefaultTlsTrust
} from './distrusted-tls-certificates'

const NSS_REMOVED_ROOTS = [
  'emSign ECC Root CA - G3',
  'emSign Root CA - C1',
  'emSign ECC Root CA - C3'
]

function commonName(pem: string): string {
  return new X509Certificate(pem).subject.match(/^CN=(.+)$/m)?.[1] ?? ''
}

const fixtureCertificates =
  readFileSync(join(__dirname, '__fixtures__', 'distrusted-emsign-certificates.pem'), 'utf8').match(
    /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g
  ) ?? []

describe('isDistrustedTlsCertificate', () => {
  it('distrusts every fixture certificate, including Sectigo cross-signed copies of each key', () => {
    expect(fixtureCertificates).toHaveLength(19)
    expect(
      fixtureCertificates.filter((pem) => !isDistrustedTlsCertificate(pem)).map(commonName)
    ).toEqual([])
  })

  it('ignores input that is not a certificate', () => {
    expect(isDistrustedTlsCertificate('not a certificate')).toBe(false)
  })
})

describe('removeDistrustedRootsFromDefaultTlsTrust', () => {
  const original = tls.getCACertificates('default')

  afterEach(() => {
    tls.setDefaultCACertificates(original)
  })

  // Exact equality also proves eMudhra's G1 root stays trusted, as in NSS 3.131.1.
  it('drops exactly the roots NSS removed and keeps every other default root', () => {
    const fingerprint = (pem: string): string => new X509Certificate(pem).fingerprint256

    const fixtureRoots = fixtureCertificates.filter((pem) =>
      NSS_REMOVED_ROOTS.includes(commonName(pem))
    )
    expect(fixtureRoots.map(commonName).sort()).toEqual([...NSS_REMOVED_ROOTS].sort())
    const retained = original.filter((pem) => !NSS_REMOVED_ROOTS.includes(commonName(pem)))
    tls.setDefaultCACertificates([...retained, ...fixtureRoots])

    removeDistrustedRootsFromDefaultTlsTrust()

    const remaining = new Set(tls.getCACertificates('default').map(fingerprint))
    expect(remaining).toEqual(new Set(retained.map(fingerprint)))
    for (const pem of fixtureRoots) {
      expect(remaining.has(fingerprint(pem))).toBe(false)
    }
  })
})
