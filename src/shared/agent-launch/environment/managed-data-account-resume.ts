/** Spawn-env request for one managed account; the host validates it and falls back to the active one. */
export const MANAGED_DATA_ACCOUNT_RESUME_ENV = 'ORCA_DATA_ACCOUNT_ID'
/** Requests the user's own store; older hosts reject it as an unknown account and fall back. */
export const SYSTEM_DATA_ACCOUNT_RESUME_ID = 'system'

const OPENCODE_ACCOUNT_STORE =
  /[\\/]managed-data-accounts[\\/]opencode[\\/]([0-9a-f-]{36})[\\/]data[\\/]opencode[\\/]/i

/** OpenCode only resumes from the store holding the row (`<db>#<session>` or legacy JSON). */
export function managedDataAccountResumeEnv(session: {
  agent: string
  filePath?: string
}): Record<string, string> {
  if ((session.agent !== 'opencode' && session.agent !== 'opencode2') || !session.filePath) {
    return {}
  }
  const accountId =
    session.filePath.match(OPENCODE_ACCOUNT_STORE)?.[1] ?? SYSTEM_DATA_ACCOUNT_RESUME_ID
  return { [MANAGED_DATA_ACCOUNT_RESUME_ENV]: accountId }
}
