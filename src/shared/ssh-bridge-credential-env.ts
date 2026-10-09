/**
 * Env var carrying the per-invocation credential a bridged SSH CLI presents instead of the owner token.
 *
 * Its presence also puts the CLI in bridge mode: no local-only commands and no paired-server routing,
 * because those act with this machine's own authority rather than through the scoped runtime socket.
 */
export const ORCA_SSH_BRIDGE_CREDENTIAL_ENV = 'ORCA_SSH_BRIDGE_CREDENTIAL'

export function readSshBridgeCredential(env: NodeJS.ProcessEnv = process.env): string | null {
  const value = env[ORCA_SSH_BRIDGE_CREDENTIAL_ENV]
  return typeof value === 'string' && value.length > 0 ? value : null
}
