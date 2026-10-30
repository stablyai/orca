import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'

export type SettingsHostScope = {
  target: RuntimeClientTarget
  /** Missing saved hosts must not silently fall back to another host. */
  available: boolean
}

export const LOCAL_SETTINGS_HOST_SCOPE: SettingsHostScope = {
  target: { kind: 'local' },
  available: true
}

export function resolveSettingsHostScope(args: {
  choice: RuntimeClientTarget | null
  /** Seeds the initial choice; never overrides an explicit selection. */
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
    // An unhydrated catalog does not prove the server was removed.
    available: !args.catalogHydrated || args.savedEnvironmentIds.includes(environmentId)
  }
}
