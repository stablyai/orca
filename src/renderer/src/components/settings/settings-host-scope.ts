import type { RuntimeClientTarget } from '@/runtime/runtime-client-target'

/** Host whose accounts, agents and terminal capabilities Settings shows; chosen in the page. */
export type SettingsHostScope = {
  target: RuntimeClientTarget
  /** False when the chosen server is no longer saved: panes say so instead of showing another host. */
  available: boolean
}

export type SettingsHostChoice = { kind: 'local' } | { kind: 'environment'; environmentId: string }

export const LOCAL_SETTINGS_HOST_SCOPE: SettingsHostScope = {
  target: { kind: 'local' },
  available: true
}

export function resolveSettingsHostScope(args: {
  /** Null until the user picks a host in the page. */
  choice: SettingsHostChoice | null
  /** The "default host for new projects" setting; only the initial default, never a later override. */
  defaultEnvironmentId: string | null | undefined
  savedEnvironmentIds: readonly string[]
  catalogHydrated: boolean
}): SettingsHostScope {
  const environmentId =
    args.choice === null
      ? args.defaultEnvironmentId?.trim() || null
      : args.choice.kind === 'environment'
        ? args.choice.environmentId
        : null
  if (!environmentId) {
    return LOCAL_SETTINGS_HOST_SCOPE
  }
  return {
    target: { kind: 'environment', environmentId },
    // Why: an unhydrated catalog is not evidence the server is gone.
    available: !args.catalogHydrated || args.savedEnvironmentIds.includes(environmentId)
  }
}

export function getSettingsHostScopeEnvironmentId(scope: SettingsHostScope): string | null {
  return scope.target.kind === 'environment' ? scope.target.environmentId : null
}
