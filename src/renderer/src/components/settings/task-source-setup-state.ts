import type { TaskProvider } from '../../../../shared/task-providers'
import type { IntegrationStatusTone } from '@/components/integration-status-pill'

export type TaskProviderReadiness = {
  connected: boolean
  checking: boolean
  unavailable?: boolean
  /** Linear only — agent skill install. Other providers leave this undefined. */
  skillInstalled?: boolean
  skillChecking?: boolean
  visible: boolean
}

export type TaskProviderSetupStatus =
  | 'checking'
  | 'ready'
  | 'connect-required'
  | 'skill-required'
  | 'unavailable'
  | 'hidden'
  | 'incomplete'

export const TASK_PROVIDER_SETUP_STATUS_TONE: Record<
  TaskProviderSetupStatus,
  IntegrationStatusTone
> = {
  checking: 'neutral',
  ready: 'connected',
  // Why: hiding a provider is a deliberate choice, not something to warn about.
  hidden: 'neutral',
  'connect-required': 'attention',
  'skill-required': 'attention',
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
  if (readiness.skillInstalled === false) {
    return 'skill-required'
  }
  // Fallback if a future readiness field can leave connected+skill true but not ready.
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

// A provider nobody has touched is the shipped default, not a problem: settings
// expose all four, so treating "never connected" as a warning would fire on
// every fresh install. Setup counts as started once a credential or the skill
// landed.
export function hasStartedTaskProviderSetup(readiness: TaskProviderReadiness): boolean {
  return readiness.connected || readiness.skillInstalled === true
}

// Warn only about setup that started and stalled partway.
export function getStalledVisibleTaskProviders(
  providers: readonly TaskProvider[],
  readinessByProvider: Record<TaskProvider, TaskProviderReadiness>
): TaskProvider[] {
  return getIncompleteVisibleTaskProviders(providers, readinessByProvider).filter((provider) =>
    hasStartedTaskProviderSetup(readinessByProvider[provider])
  )
}

// Expand one unfinished provider because defaults expose every provider.
export function getAutoExpandedTaskProvider(
  providers: readonly TaskProvider[],
  readinessByProvider: Record<TaskProvider, TaskProviderReadiness>
): TaskProvider | null {
  return getIncompleteVisibleTaskProviders(providers, readinessByProvider)[0] ?? null
}

// Auto-expand is a one-time first-open affordance. Once a card has claimed it,
// it keeps it for the life of the pane: releasing the slot when that provider
// finishes (or gets hidden) would let a later gh/glab preflight pop a different
// card open under the user, and could unmount an open install terminal.
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
