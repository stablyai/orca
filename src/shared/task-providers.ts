import { parseExecutionHostId } from './execution-host'

export type TaskProvider = 'github' | 'gitlab' | 'linear' | 'jira' | 'beads'

export const TASK_PROVIDERS: readonly TaskProvider[] = [
  'github',
  'gitlab',
  'linear',
  'jira',
  'beads'
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
  bdInstalled: boolean
}

// Why: bd runs on the host that owns the repo checkout (unlike gh/glab, which run
// on the client), so repos on ssh/runtime hosts keep Beads available without a
// local bd — the Tasks page surfaces per-host bd state once fetches settle.
// Mirrors canUseGitLabSmartSource's remote-host escape hatch.
export function resolveBeadsTaskProviderAvailability(args: {
  localBdInstalled: boolean
  repoHostIds: Iterable<string | null | undefined>
}): boolean {
  if (args.localBdInstalled) {
    return true
  }
  for (const hostId of args.repoHostIds) {
    const kind = parseExecutionHostId(hostId)?.kind
    if (kind === 'ssh' || kind === 'runtime') {
      return true
    }
  }
  return false
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

// Why: the picker can render providers resurrected beyond the stored list (see
// restoreAvailableDefaultTaskProvider); persisting the union keeps what the user
// sees from silently dropping out of settings when the default moves elsewhere.
export function mergeRenderedVisibleTaskProviders(
  storedVisible: readonly TaskProvider[],
  rendered: readonly TaskProvider[]
): TaskProvider[] {
  return TASK_PROVIDERS.filter(
    (provider) => storedVisible.includes(provider) || rendered.includes(provider)
  )
}

function isTaskProviderAvailable(
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
  if (provider === 'beads') {
    return availability.bdInstalled
  }
  return availability.linearConnected
}

export function resolveVisibleTaskProvider(
  preferred: TaskProvider | null | undefined,
  visibleProviders: readonly TaskProvider[]
): TaskProvider {
  if (preferred && visibleProviders.includes(preferred)) {
    return preferred
  }
  return visibleProviders[0] ?? 'github'
}
