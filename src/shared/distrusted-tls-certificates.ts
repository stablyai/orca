import { createHash, X509Certificate } from 'node:crypto'
import * as tls from 'node:tls'
import { getPemCertificateSha256 } from './pem-certificate-sha256'

// Drop both sets once the bundled Electron's Node ships NSS 3.131.1 roots and Chromium has caught up.

// Roots NSS 3.131.1 removed (nodejs/node#66877), by certificate SHA-256 so startup
// hashes the bundled roots instead of parsing each one.
const DISTRUSTED_ROOT_CERTIFICATE_SHA256: ReadonlySet<string> = new Set([
  '86a1ecba089c4a8d3bbe2734c612ba341d813e043cf9e8a862cd5c57a36bbe6b', // emSign ECC Root CA - G3
  '125609aa301da0a249b97a8239cb6a34216f44dcac9f3954b14292f2e8c8608f', // emSign Root CA - C1
  'bc4d809b15189d78db3e1d8cf4f9726a795da1643ca5f1358e1ddb0edc0d7eb3' // emSign ECC Root CA - C3
])

// SHA-256 of each SubjectPublicKeyInfo, so cross-signed copies of the same CA key match too.
const DISTRUSTED_PUBLIC_KEY_SHA256: ReadonlySet<string> = new Set([
  // eMudhra intermediates whose private keys are publicly recoverable (Mozilla bug 2083449).
  'ebed6475c2c2d80fcb199f3fe8dd6e6b3ce60b77eb15d4e42c3dec0c6f5b5105', // EM DV TLS CA - G3B
  '49dd353dc2b919a3770645117d0e60c16115e7d1bc259eefe734b00ea434fe5f', // EM DV TLS CA - G3C
  'e0254c7fcdc265e2f0f8a428dabb75ab4ae039b4872d62f5ee57f0877d5a8a41', // EM EV TLS CA - G3B
  '5c0660a2b164910d8ff589c18e14552e9e0ec237dcefe2cb736d41a4811f81a0', // EM EV TLS CA - G3C
  '43bffa19d6ef651451f6841e019931e96f6f2eaeff28ab4b6f1ce4576de2717b', // EM OV TLS CA - G3B
  '63ecefee431d49523bc1136c4e72d0206a477086caf606cd5cf025686c109cf8', // EM OV TLS CA - G3C
  'ec4ffa1ad0ac88081314b7aaffef6a91f97cd57291bb5ba686c5415f5eb4f6b6', // EM OV CS CA - G3B
  '92c063d67e8f14db71d288e11266ffdaf69cbf115f7bab14f3bc2f68d25e0e30', // EM OV CS CA - G3C
  // The removed roots' keys.
  '8d417db2dd8bf5e3084d1e3f196d583849d81bdd4c00c70b9d39369e96b8c782', // emSign ECC Root CA - G3
  'b7408b4d2be0238ba37004dd34e276c6019bd2f24c9db7d4980f5f6c359a4bcc', // emSign Root CA - C1
  'eabc185c4e82d942b1a5978ba3c0181487d6b3b9974e5c49f72f6d0bd9637150' // emSign ECC Root CA - C3
])

export function isDistrustedTlsCertificate(pem: string): boolean {
  let spki: Buffer
  try {
    spki = new X509Certificate(pem).publicKey.export({ type: 'spki', format: 'der' })
  } catch {
    return false
  }
  return DISTRUSTED_PUBLIC_KEY_SHA256.has(createHash('sha256').update(spki).digest('hex'))
}

function isDistrustedRoot(pem: string): boolean {
  const digest = getPemCertificateSha256(pem)
  return digest !== null && DISTRUSTED_ROOT_CERTIFICATE_SHA256.has(digest)
}

// Why: Node's bundled roots get no OneCRL/CRLSet updates, so removal is the only way to
// distrust them; call before the first TLS socket, since agents and pools keep their contexts.
export function removeDistrustedRootsFromDefaultTlsTrust(): void {
  // Node < 24.5 and Bun lack these APIs.
  if (
    typeof tls.getCACertificates !== 'function' ||
    typeof tls.setDefaultCACertificates !== 'function'
  ) {
    return
  }
  const current = tls.getCACertificates('default')
  const kept = current.filter((pem) => !isDistrustedRoot(pem))
  if (kept.length !== current.length) {
    tls.setDefaultCACertificates(kept)
  }
}
