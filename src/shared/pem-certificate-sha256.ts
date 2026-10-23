import { createHash } from 'node:crypto'

// SHA-256 of the first PEM certificate's DER, without parsing it as X.509.
export function getPemCertificateSha256(pem: string): string | null {
  const match = pem.match(/-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/)
  if (!match) {
    return null
  }
  try {
    const der = Buffer.from(match[1].replace(/\s+/g, ''), 'base64')
    return der.length > 0 ? createHash('sha256').update(der).digest('hex') : null
  } catch {
    return null
  }
}
