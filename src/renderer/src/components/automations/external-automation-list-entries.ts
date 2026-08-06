import type {
  ExternalAutomationJob,
  ExternalAutomationManager
} from '../../../../shared/automations-types'
import {
  getExternalAutomationKey,
  getExternalAutomationSourceKey
} from './external-automation-display'

export type ExternalAutomationListEntry =
  | {
      kind: 'job'
      key: string
      manager: ExternalAutomationManager
      job: ExternalAutomationJob
    }
  | {
      kind: 'source'
      key: string
      manager: ExternalAutomationManager
    }

export function buildExternalAutomationListEntries(
  managers: readonly ExternalAutomationManager[]
): ExternalAutomationListEntry[] {
  return managers.flatMap((manager): ExternalAutomationListEntry[] => {
    if (manager.jobs.length === 0) {
      if (manager.provider === 'hermes' && (manager.status === 'unavailable' || manager.error)) {
        return [
          {
            kind: 'source' as const,
            key: getExternalAutomationSourceKey(manager),
            manager
          }
        ]
      }
      return []
    }
    return manager.jobs.map((job) => ({
      kind: 'job' as const,
      key: getExternalAutomationKey(manager, job),
      manager,
      job
    }))
  })
}
