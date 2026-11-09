import type { RuntimeEnvironmentSource } from './runtime-environments'

// Saved server names must be unique, so an Orca Cloud server is stored as
// "<repo> sandbox <runtime id tail>". People see "Orca Cloud": the workspace row already names
// the workspace, and the id tail means nothing to them.
const ORCA_CLOUD_ENVIRONMENT_NAME = /^.+ sandbox [0-9A-Za-z]{8}$/

/** The host label for every Orca Cloud server, like "Local Mac" for this computer. */
export const ORCA_CLOUD_HOST_LABEL = 'Orca Cloud'

/** The saved (unique) name of the server behind one Orca Cloud workspace. */
export function orcaCloudEnvironmentName(repoName: string, runtimeId: string): string {
  return `${repoName} sandbox ${runtimeId.slice(-8)}`
}

/** Builds before the glossary named the server "<repo> VM <id tail>"; the runtime record proves it was Orca Cloud. */
export function legacyOrcaCloudEnvironmentName(name: string, runtimeId: string): string | null {
  const suffix = ` VM ${runtimeId.slice(-8)}`
  return name.endsWith(suffix) && name.length > suffix.length
    ? orcaCloudEnvironmentName(name.slice(0, -suffix.length), runtimeId)
    : null
}

export function isOrcaCloudRuntimeEnvironment(environment: {
  name?: string | null
  source?: RuntimeEnvironmentSource
}): boolean {
  return (
    environment.source === 'ephemeral-vm' &&
    ORCA_CLOUD_ENVIRONMENT_NAME.test(environment.name?.trim() ?? '')
  )
}

/** The name to show for a saved server: "Orca Cloud" for a cloud sandbox, otherwise its saved name. */
export function runtimeEnvironmentDisplayName(environment: {
  name: string
  source?: RuntimeEnvironmentSource
}): string {
  return isOrcaCloudRuntimeEnvironment(environment) ? ORCA_CLOUD_HOST_LABEL : environment.name
}
