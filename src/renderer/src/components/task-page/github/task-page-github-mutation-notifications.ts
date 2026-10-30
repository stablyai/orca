import type { ListRetirement } from './task-page-github-work-item-list-model'

const listeners = new Set<() => void>()

export function subscribeTaskPageGitHubMutationRegistry(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
let notificationDepth = 0
let notificationPending = false
let batchRetirements: ListRetirement[] = []
export function publishListRetirements(
  retirements: readonly ListRetirement[],
  markGitHubTaskListRetirements: (retirements: readonly ListRetirement[]) => void
): void {
  if (notificationDepth) {
    batchRetirements.push(...retirements)
  } else {
    markGitHubTaskListRetirements(retirements)
  }
}
export function batchTaskPageGitHubMutationRegistry<T>(
  operation: () => T,
  markGitHubTaskListRetirements: (retirements: readonly ListRetirement[]) => void
): T {
  notificationDepth++
  try {
    return operation()
  } finally {
    notificationDepth--
    if (!notificationDepth && batchRetirements.length) {
      const retirements = batchRetirements
      batchRetirements = []
      markGitHubTaskListRetirements(retirements)
    }
    if (!notificationDepth && notificationPending) {
      notificationPending = false
      notifyTaskPageGitHubMutationRegistry()
    }
  }
}
export function notifyTaskPageGitHubMutationRegistry(): void {
  if (notificationDepth) {
    notificationPending = true
    return
  }
  for (const listener of listeners) {
    listener()
  }
}
export function clearTaskPageGitHubMutationRegistryListenersForTests(): void {
  listeners.clear()
}
