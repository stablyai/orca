import os from 'node:os'

export type LocalhostSshTarget = {
  label: string
  host: string
  port: number
  username: string
  configHost?: string
  identityFile?: string
}

function parsePort(value: string | undefined): number {
  const parsed = Number(value ?? '22')
  if (Number.isInteger(parsed) && parsed > 0 && parsed <= 65535) {
    return parsed
  }
  throw new Error(`Invalid ORCA_E2E_SSH_PORT: ${value}`)
}

function currentUsername(): string {
  return (
    process.env.ORCA_E2E_SSH_USER ??
    process.env.USER ??
    process.env.USERNAME ??
    os.userInfo().username
  )
}

/** The localhost SSH target the opt-in E2E specs connect to, read from ORCA_E2E_SSH_* env vars. */
export function readLocalhostSshTarget(label: string): LocalhostSshTarget {
  const configHost = process.env.ORCA_E2E_SSH_CONFIG_HOST?.trim()
  // Why: `||`, not `??` — an empty override must still fall back to 127.0.0.1.
  const host = process.env.ORCA_E2E_SSH_HOST?.trim() || (configHost ? '' : '127.0.0.1')
  const identityFile = process.env.ORCA_E2E_SSH_IDENTITY_FILE?.trim()

  return {
    label,
    host,
    port: parsePort(process.env.ORCA_E2E_SSH_PORT),
    username: currentUsername(),
    ...(configHost ? { configHost } : {}),
    ...(identityFile ? { identityFile } : {})
  }
}
