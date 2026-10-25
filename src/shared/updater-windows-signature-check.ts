// Detect failed Get-AuthenticodeSignature spawning (EDR, timeout, revocation stalls) for actionable copy.
// Exclude wrong-publisher mismatches: those are integrity failures, not environment interference.
export function isWindowsSignatureCheckUnavailableFailure(message: string): boolean {
  const normalized = message.toLowerCase()
  if (normalized.includes('not signed by the application owner')) {
    return false
  }
  return normalized.includes('get-authenticodesignature')
}

// electron-updater uses this phrase for a readable installer signed by the wrong owner; require a security stop, not ordinary retry copy.
export function isWindowsSignatureMismatchFailure(message: string): boolean {
  return message.toLowerCase().includes('not signed by the application owner')
}
