export const ORCA_CLI_OWNING_HOST_ENV = 'ORCA_CLI_OWNING_HOST'

export function bindOrcaCliToExecutionHost(
  env: Record<string, string>,
  userDataPath: string
): void {
  env.ORCA_USER_DATA_PATH = userDataPath
  env[ORCA_CLI_OWNING_HOST_ENV] = '1'
}

export function readCliRemoteSelectionDefaults(env: NodeJS.ProcessEnv = process.env): {
  pairingCode: string | null
  environment: string | null
} {
  // Shell profiles cannot retarget a child's owning-server CLI; explicit flags still can.
  if (env[ORCA_CLI_OWNING_HOST_ENV] === '1') {
    return { pairingCode: null, environment: null }
  }
  return {
    pairingCode: env.ORCA_PAIRING_CODE ?? env.ORCA_REMOTE_PAIRING ?? null,
    environment: env.ORCA_ENVIRONMENT ?? null
  }
}
