// Orca reads these for its own forge API calls; agents, terminals and their tools must not see them (#44365).
export const ORCA_FORGE_CREDENTIAL_ENV_KEYS = [
  'ORCA_AZURE_DEVOPS_TOKEN',
  'ORCA_AZURE_DEVOPS_PAT',
  'ORCA_AZURE_DEVOPS_ACCESS_TOKEN',
  'ORCA_GITEA_TOKEN',
  'ORCA_BITBUCKET_ACCESS_TOKEN',
  'ORCA_BITBUCKET_API_TOKEN'
] as const

const credentialKeys = new Set<string>(ORCA_FORGE_CREDENTIAL_ENV_KEYS)

export function isOrcaForgeCredentialEnvKey(key: string, platform: NodeJS.Platform): boolean {
  // Windows environment names are case-insensitive, so `orca_gitea_token` is the same variable.
  return credentialKeys.has(platform === 'win32' ? key.toUpperCase() : key)
}

export function stripOrcaForgeCredentialEnv(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform
): void {
  for (const key of Object.keys(env)) {
    if (isOrcaForgeCredentialEnvKey(key, platform)) {
      delete env[key]
    }
  }
}
