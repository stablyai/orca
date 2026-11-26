export const AI_VAULT_CMD_CODEX_HOME_ENV = 'ORCA_AI_VAULT_CMD_CODEX_HOME'

export function withPinnedCmdCodexHome(
  env: Record<string, string> | undefined,
  codexHome: string | undefined
): Record<string, string> | undefined {
  return codexHome ? { ...env, [AI_VAULT_CMD_CODEX_HOME_ENV]: codexHome } : env
}

export function applyPinnedCmdCodexHome(
  env: Record<string, string>,
  explicitEnv: Record<string, string> | undefined,
  apply: boolean
): void {
  delete env[AI_VAULT_CMD_CODEX_HOME_ENV]
  const codexHome = apply ? explicitEnv?.[AI_VAULT_CMD_CODEX_HOME_ENV] : undefined
  if (!codexHome) {
    return
  }
  // Apply after host account injection, as the session's cmd prefix used to.
  for (const key of Object.keys(env)) {
    if (key.toUpperCase() === 'CODEX_HOME') {
      delete env[key]
    }
  }
  env.CODEX_HOME = codexHome
}
