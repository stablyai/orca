// Split out of protocol-version.ts, which lists it in RUNTIME_CAPABILITIES. Import it from here.

// Why: a static capability for the perforce.* family (workspace operations, copies, descriptions),
// so a client hides Perforce on an older host instead of failing every detect on every sync.
// It says the build has the methods; whether p4 is installed there is perforce.detect's answer.
export const PERFORCE_RUNTIME_CAPABILITY = 'perforce.v1' as const
export const PERFORCE_UPDATE_REQUIRED_MESSAGE =
  'The Orca server on this host does not support Perforce yet. Update Orca on that host.'
