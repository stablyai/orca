import { getSettingsFocusedExecutionHostId } from '../../../shared/execution-host'
import {
  normalizeTaskSourceContext,
  type TaskSourceContext
} from '../../../shared/task-source-context'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import type { OdooInstance, OdooTicket } from '../../../shared/odoo-types'
/** Mirrors bindTaskPageJiraItemSourceContext: the composer refuses to link a
 *  work item whose source identity can't be resolved, so this looks up the
 *  exact instance the ticket belongs to rather than trusting whichever
 *  instance happens to be active. */
export function bindTaskPageOdooItemSourceContext(args: {
  ticket: OdooTicket
  instances: readonly OdooInstance[]
  settings: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'>
}): TaskSourceContext | null {
  const instance =
    args.instances.find((candidate) => candidate.id === args.ticket.instanceId) ??
    // Legacy tickets predating multi-instance support carry no instanceId; a
    // single configured instance is still an unambiguous match.
    (args.ticket.instanceId === undefined && args.instances.length === 1
      ? args.instances[0]
      : undefined)
  if (!instance) {
    return null
  }
  return normalizeTaskSourceContext({
    provider: 'odoo',
    projectId: 'account-backed-task-source',
    hostId: getSettingsFocusedExecutionHostId(args.settings),
    providerIdentity: {
      provider: 'odoo',
      instanceId: instance.id,
      serverUrl: instance.serverUrl,
      database: instance.database,
      projectId: args.ticket.project?.id ?? null
    },
    accountLabel: instance.displayName || instance.serverUrl
  })
}
