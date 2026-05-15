export type TaskProvider = 'github' | 'gitlab' | 'linear'

export const TASK_PROVIDERS: readonly TaskProvider[] = ['github', 'gitlab', 'linear']

const TASK_PROVIDER_SET = new Set<TaskProvider>(TASK_PROVIDERS)

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

export function resolveVisibleTaskProvider(
  preferred: TaskProvider | null | undefined,
  visibleProviders: readonly TaskProvider[]
): TaskProvider {
  if (preferred && visibleProviders.includes(preferred)) {
    return preferred
  }
  return visibleProviders[0] ?? 'github'
}
