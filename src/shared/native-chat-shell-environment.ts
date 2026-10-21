import type { GlobalSettings } from './global-settings-types'

/** Which login-shell variables a structured native chat child inherits. */
export type NativeChatShellEnvironmentPolicy = {
  inheritAll: boolean
  names: readonly string[]
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

/** One whole variable name, as a shell would accept it; the only rule the list control and the normalizer share. */
export function isNativeChatShellEnvironmentName(value: string): boolean {
  return ENV_NAME.test(value)
}

/** The persisted list as a valid, deduplicated name list; anything malformed (hand-edited file) is empty. */
export function normalizeNativeChatShellEnvironmentVariables(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return []
  }
  const names: string[] = []
  for (const entry of value) {
    // Validate each saved entry whole; re-splitting would turn "not valid" into two names.
    if (
      typeof entry === 'string' &&
      isNativeChatShellEnvironmentName(entry) &&
      !names.includes(entry)
    ) {
      names.push(entry)
    }
  }
  return names
}

export function nativeChatShellEnvironmentPolicy(
  settings: Pick<
    GlobalSettings,
    'nativeChatInheritShellEnvironment' | 'nativeChatShellEnvironmentVariables'
  > | null
): NativeChatShellEnvironmentPolicy {
  return {
    inheritAll: settings?.nativeChatInheritShellEnvironment !== false,
    names: normalizeNativeChatShellEnvironmentVariables(
      settings?.nativeChatShellEnvironmentVariables
    )
  }
}
