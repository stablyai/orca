// Why: electron-updater verifies Windows installers by spawning PowerShell's
// Get-AuthenticodeSignature. Antivirus/EDR interception, its hardcoded 20s
// timeout, or stalled revocation lookups kill that spawn, and the raw
// child-process failure becomes the update error. Detect that shape so the UI
// can explain it instead of dumping the command line. A true signature
// mismatch ("not signed by the application owner") must NOT match — that is a
// real integrity failure, not environment interference.
export function isWindowsSignatureCheckUnavailableFailure(message: string): boolean {
  const normalized = message.toLowerCase()
  if (normalized.includes('not signed by the application owner')) {
    return false
  }
  return normalized.includes('get-authenticodesignature')
}

// Why: electron-updater throws ERR_UPDATER_INVALID_SIGNATURE with this exact
// phrase when the downloaded installer is validly readable but signed by the
// wrong publisher — a genuine integrity failure, NOT environment interference.
// This must drive a security-stop message (no silent "retry" framing) and stay
// distinct from isWindowsSignatureCheckUnavailableFailure above.
export function isWindowsSignatureMismatchFailure(message: string): boolean {
  return message.toLowerCase().includes('not signed by the application owner')
}
