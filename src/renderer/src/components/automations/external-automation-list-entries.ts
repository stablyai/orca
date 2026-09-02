import type {
  ExternalAutomationJob,
  ExternalAutomationManager
} from '../../../../shared/automations-types'
import type {
  ExternalAutomationScope,
  ScopedExternalAutomationManager
} from './external-automation-scope-client'
import { externalAutomationJobKey } from './external-automation-scope-keys'

export type ExternalAutomationListEntry = {
  key: string
  /** The scope the manager was listed under; carried so the key never has to be re-derived. */
  scope: ExternalAutomationScope
  manager: ExternalAutomationManager
  job: ExternalAutomationJob
}

export function buildExternalAutomationListEntries(
  scopedManagers: readonly ScopedExternalAutomationManager[]
): ExternalAutomationListEntry[] {
  // Why: empty managers are host probes, not automations — omit them from the list.
  return scopedManagers.flatMap(({ scope, manager }) =>
    manager.jobs.map((job) => ({
      // A scope holds at most one manager, so {scope, job} names the row exactly.
      key: externalAutomationJobKey(scope, job.id),
      scope,
      manager,
      job
    }))
  )
}
