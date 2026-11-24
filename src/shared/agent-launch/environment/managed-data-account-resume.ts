/** Spawn-env request for one managed account; the host validates it and falls back to the active one. */
export const MANAGED_DATA_ACCOUNT_RESUME_ENV = 'ORCA_DATA_ACCOUNT_ID'
/** Requests the user's own store; older hosts reject it as an unknown account and fall back. */
export const SYSTEM_DATA_ACCOUNT_RESUME_ID = 'system'

const OPENCODE_ACCOUNT_STORE =
  /[\\/]managed-data-accounts[\\/]opencode[\\/]([0-9a-f-]{36})[\\/]data[\\/]opencode[\\/]/i

const DEVIN_ACCOUNT_STORE =
  /[\\/]managed-data-accounts[\\/]devin[\\/]([0-9a-f-]{36})[\\/]data[\\/]devin[\\/]cli[\\/]/i

/** A resume must target the store holding the row, not the currently selected account. */
export function managedDataAccountResumeEnv(session: {
  agent: string
  filePath?: string
}): Record<string, string> {
  const store =
    session.agent === 'devin'
      ? DEVIN_ACCOUNT_STORE
      : session.agent === 'opencode' || session.agent === 'opencode2'
        ? OPENCODE_ACCOUNT_STORE
        : null
  if (!store || !session.filePath) {
    return {}
  }
  const accountId = session.filePath.match(store)?.[1] ?? SYSTEM_DATA_ACCOUNT_RESUME_ID
  return { [MANAGED_DATA_ACCOUNT_RESUME_ENV]: accountId }
}
