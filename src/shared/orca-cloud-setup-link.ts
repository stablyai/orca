// The setup done page (auth.onorca.dev/cloud/setup/done) opens
// orca://cloud/setup/return?session=<id>. The desktop never depends on it (polling already sees
// every step); the link only focuses Orca and asks the open setup tracker to re-read right away.

/** IPC channel main uses to hand a parsed return link to the renderer. */
export const ORCA_CLOUD_SETUP_RETURN_CHANNEL = 'cloudSetup:return'

/** Setup session ids are minted by the billing Worker: `cs_` + 22 base64url characters. */
const CLOUD_SETUP_SESSION_ID_PATTERN = /^cs_[A-Za-z0-9_-]{22}$/

export type OrcaCloudSetupReturn = { sessionId: string }

/** Parses `orca://cloud/setup/return?session=cs_…`; anything else (or a malformed id) is null. */
export function parseOrcaCloudSetupReturnLink(raw: string): OrcaCloudSetupReturn | null {
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    return null
  }
  if (
    url.protocol !== 'orca:' ||
    url.hostname !== 'cloud' ||
    url.pathname.replace(/\/$/, '') !== '/setup/return'
  ) {
    return null
  }
  const sessionId = url.searchParams.get('session')
  return sessionId && CLOUD_SETUP_SESSION_ID_PATTERN.test(sessionId) ? { sessionId } : null
}

export function findOrcaCloudSetupReturnLink(argv: readonly string[]): OrcaCloudSetupReturn | null {
  for (const arg of argv) {
    const parsed = parseOrcaCloudSetupReturnLink(arg)
    if (parsed) {
      return parsed
    }
  }
  return null
}
