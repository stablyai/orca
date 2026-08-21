import type {
  ExternalAutomationJob,
  ExternalAutomationManager
} from '../../../../shared/automations-types'
import { getExternalAutomationKey } from './external-automation-display'

export type ExternalAutomationListEntry = {
  key: string
  manager: ExternalAutomationManager
  job: ExternalAutomationJob
}

export function buildExternalAutomationListEntries(
  managers: readonly ExternalAutomationManager[]
): ExternalAutomationListEntry[] {
  // Why: empty managers are host probes, not automations — omit them from the list.
  return managers.flatMap((manager) =>
    manager.jobs.map((job) => ({
      key: getExternalAutomationKey(manager, job),
      manager,
      job
    }))
  )
}
