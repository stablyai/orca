export type TaskProvider = 'github' | 'gitlab' | 'linear' | 'jira' | 'huly'

export const TASK_PROVIDERS: readonly TaskProvider[] = [
  'github',
  'gitlab',
  'linear',
  'jira',
  'huly'
]

const TASK_PROVIDER_SET = new Set<TaskProvider>(TASK_PROVIDERS)

export function isTaskProvider(value: unknown): value is TaskProvider {
  return TASK_PROVIDER_SET.has(value as TaskProvider)
}

export function normalizeTaskProviderSettings(value: {
  visibleTaskProviders: unknown
  defaultTaskSource: unknown
}): { visibleTaskProviders: TaskProvider[]; defaultTaskSource: TaskProvider } {
  const visibleTaskProviders = normalizeVisibleTaskProviders(value.visibleTaskProviders)
  const defaultTaskSource = isTaskProvider(value.defaultTaskSource)
    ? value.defaultTaskSource
    : resolveVisibleTaskProvider('github', visibleTaskProviders)

  if (visibleTaskProviders.includes(defaultTaskSource)) {
    return { visibleTaskProviders, defaultTaskSource }
  }

  // Why: older profiles can keep a saved default while the visible-provider
  // list drifted. Persist the default back into the list so every surface
  // reads the same settings contract.
  return {
    defaultTaskSource,
    visibleTaskProviders: TASK_PROVIDERS.filter(
      (provider) => provider === defaultTaskSource || visibleTaskProviders.includes(provider)
    )
  }
}

export function normalizeVisibleTaskProviders(value: unknown): TaskProvider[] {
  if (!Array.isArray(value)) {
    return [...TASK_PROVIDERS]
  }

  const normalized: TaskProvider[] = []
  for (const provider of value) {
    if (!TASK_PROVIDER_SET.has(provider as TaskProvider)) {
      continue
    }
    if (!normalized.includes(provider as TaskProvider)) {
      normalized.push(provider as TaskProvider)
    }
  }

  // Why: at least one provider must remain visible so the Tasks surface always
  // has a valid source to select after settings hydration or manual edits.
  return normalized.length > 0 ? normalized : [...TASK_PROVIDERS]
}

export type TaskProviderAvailability = {
  gitlabInstalled: boolean
  linearConnected: boolean
  hulyConnected: boolean
}

export function filterAvailableTaskProviders(
  visibleProviders: readonly TaskProvider[],
  availability: TaskProviderAvailability
): TaskProvider[] {
  const available = visibleProviders.filter((provider) =>
    isTaskProviderAvailable(provider, availability)
  )

  return available.length > 0 ? available : ['github']
}

export function restoreAvailableDefaultTaskProvider(
  visibleProviders: readonly TaskProvider[],
  availability: TaskProviderAvailability,
  preferredProvider: unknown
): TaskProvider[] {
  const available = filterAvailableTaskProviders(visibleProviders, availability)

  // Why: older or drifted settings can hide the saved default while another
  // provider becomes available. Keep that default reachable after hydration.
  if (
    isTaskProvider(preferredProvider) &&
    isTaskProviderAvailable(preferredProvider, availability) &&
    !available.includes(preferredProvider)
  ) {
    return TASK_PROVIDERS.filter(
      (provider) => provider === preferredProvider || available.includes(provider)
    )
  }

  return available
}

export function isTaskProviderAvailable(
  provider: TaskProvider,
  availability: TaskProviderAvailability
): boolean {
  if (provider === 'github') {
    return true
  }
  if (provider === 'gitlab') {
    return availability.gitlabInstalled
  }
  // Why: Jira can be connected from the Tasks surface itself, so hiding it
  // when disconnected would remove the entry point for first-time setup.
  if (provider === 'jira') {
    return true
  }
  if (provider === 'huly') {
    return availability.hulyConnected
  }
  return availability.linearConnected
}

// Why: Huly-first when configured. The default order matches TASK_PROVIDERS
// (Huly appended at the end for existing users), but when Huly is connected,
// promote it to position 0 so the Tasks picker and default selection open to it.
export function orderTaskProviders(
  visibleProviders: readonly TaskProvider[],
  availability: TaskProviderAvailability | undefined
): TaskProvider[] {
  const base = visibleProviders.filter(isTaskProvider)
  if (!availability?.hulyConnected || !base.includes('huly') || base[0] === 'huly') {
    return [...base]
  }
  return ['huly', ...base.filter((provider) => provider !== 'huly')]
}

export function resolveVisibleTaskProvider(
  preferred: TaskProvider | null | undefined,
  visibleProviders: readonly TaskProvider[],
  availability?: TaskProviderAvailability
): TaskProvider {
  const ordered = orderTaskProviders(visibleProviders, availability)
  if (preferred && visibleProviders.includes(preferred)) {
    return preferred
  }
  if (availability?.hulyConnected && ordered.includes('huly')) {
    return 'huly'
  }
  return ordered[0] ?? 'github'
}
