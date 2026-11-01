import type { TaskProvider } from '../../../../shared/task-providers'
import type { IntegrationStatusTone } from '@/components/integration-status-pill'

export type TaskProviderReadiness = {
  connected: boolean
  checking: boolean
  unavailable?: boolean
  /** Linear only — agent skill install. Other providers leave this undefined. */
  skillInstalled?: boolean
  skillChecking?: boolean
  /** The scan could not vouch for `skillInstalled: false`: an unread root, or an error before any answer. */
  skillUnverifiable?: boolean
  visible: boolean
}

export type TaskProviderSetupStatus =
  | 'checking'
  | 'ready'
  | 'connect-required'
  | 'skill-required'
  | 'skill-unverified'
  | 'unavailable'
  | 'hidden'
  | 'incomplete'

export const TASK_PROVIDER_SETUP_STATUS_TONE: Record<
  TaskProviderSetupStatus,
  IntegrationStatusTone
> = {
  checking: 'neutral',
  ready: 'connected',
  // Hiding a provider is deliberate; suppress setup warnings.
  hidden: 'neutral',
  'connect-required': 'attention',
  'skill-required': 'attention',
  'skill-unverified': 'attention',
  unavailable: 'attention',
  incomplete: 'attention'
}

export function isTaskProviderChecking(readiness: TaskProviderReadiness): boolean {
  return readiness.checking || readiness.skillChecking === true
}

export function getTaskProviderCompletedSteps(readiness: TaskProviderReadiness): {
  completed: number
  total: number
} {
  const skillRequired = readiness.skillInstalled !== undefined
  const total = skillRequired ? 3 : 2
  let completed = 0
  if (readiness.connected) {
    completed += 1
  }
  if (skillRequired && readiness.skillInstalled) {
    completed += 1
  }
  if (readiness.visible) {
    completed += 1
  }
  return { completed, total }
}

export function isTaskProviderReady(readiness: TaskProviderReadiness): boolean {
  if (isTaskProviderChecking(readiness) || readiness.unavailable) {
    return false
  }
  const { completed, total } = getTaskProviderCompletedSteps(readiness)
  return completed === total
}

export function getTaskProviderSetupStatus(
  readiness: TaskProviderReadiness
): TaskProviderSetupStatus {
  if (!readiness.visible) {
    return 'hidden'
  }
  if (isTaskProviderChecking(readiness)) {
    return 'checking'
  }
  if (readiness.unavailable) {
    return 'unavailable'
  }
  if (isTaskProviderReady(readiness)) {
    return 'ready'
  }
  if (!readiness.connected) {
    return 'connect-required'
  }
  // Unverifiable scans must not offer Install for skills that may already exist.
  if (readiness.skillUnverifiable) {
    return 'skill-unverified'
  }
  if (readiness.skillInstalled === false) {
    return 'skill-required'
  }
  return 'incomplete'
}

// Exclude in-flight checks so a cold settings open does not flash a warning.
export function getIncompleteVisibleTaskProviders(
  providers: readonly TaskProvider[],
  readinessByProvider: Record<TaskProvider, TaskProviderReadiness>
): TaskProvider[] {
  return providers.filter((provider) => {
    const readiness = readinessByProvider[provider]
    if (!readiness.visible || isTaskProviderChecking(readiness)) {
      return false
    }
    return !isTaskProviderReady(readiness)
  })
}

// All providers start visible; warn only once credentials or a skill prove setup began.
export function hasStartedTaskProviderSetup(readiness: TaskProviderReadiness): boolean {
  return readiness.connected || readiness.skillInstalled === true
}

export function getStalledVisibleTaskProviders(
  providers: readonly TaskProvider[],
  readinessByProvider: Record<TaskProvider, TaskProviderReadiness>
): TaskProvider[] {
  return getIncompleteVisibleTaskProviders(providers, readinessByProvider).filter((provider) =>
    hasStartedTaskProviderSetup(readinessByProvider[provider])
  )
}

// Expand only one unfinished provider because every provider starts visible.
export function getAutoExpandedTaskProvider(
  providers: readonly TaskProvider[],
  readinessByProvider: Record<TaskProvider, TaskProviderReadiness>
): TaskProvider | null {
  return getIncompleteVisibleTaskProviders(providers, readinessByProvider)[0] ?? null
}

// Retain the first expansion slot until unmount; later preflights must not pop open another card or unmount an install terminal.
export function resolveStickyAutoExpandedTaskProvider({
  providers,
  readinessByProvider,
  previousAutoExpanded
}: {
  providers: readonly TaskProvider[]
  readinessByProvider: Record<TaskProvider, TaskProviderReadiness>
  previousAutoExpanded: TaskProvider | null
}): TaskProvider | null {
  return previousAutoExpanded ?? getAutoExpandedTaskProvider(providers, readinessByProvider)
}
