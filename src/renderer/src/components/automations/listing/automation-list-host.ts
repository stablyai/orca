import type { Repo } from '../../../../../shared/repository/repo-types'
import {
  getExecutionHostLabel,
  getRepoExecutionHostId,
  LOCAL_EXECUTION_HOST_ID
} from '../../../../../shared/execution-host/execution-host'
import type { AutomationListRow } from './automation-list-row-identity'
import type { Translate } from '@/i18n/use-translate'
import type { ExternalAutomationListEntry } from '../external/external-automation-list-entries'
import { getExternalTargetKindLabel } from '../external/external-automation-display'

/** The host a row runs on; legacy rows without a catalog label fall back to their run context. */
export function automationRowHostLabel(
  row: Pick<AutomationListRow, 'automation' | 'hostLabel'>,
  repo: Repo | undefined,
  hostLabelById: ReadonlyMap<string, string>
): string {
  if (row.hostLabel) {
    return row.hostLabel
  }
  const hostId =
    row.automation.runContext?.hostId ??
    (repo ? getRepoExecutionHostId(repo) : LOCAL_EXECUTION_HOST_ID)
  return hostLabelById.get(hostId) ?? getExecutionHostLabel(hostId)
}

/** The machine an external manager's job runs on. */
export function externalAutomationHostLabel(
  entry: Pick<ExternalAutomationListEntry, 'manager'>,
  t: Translate
): string {
  return (
    entry.manager.targetLabel || entry.manager.label || getExternalTargetKindLabel(entry.manager, t)
  )
}

/** A Host column only earns its width when the listed automations span more than one host. */
export function hasMultipleAutomationHosts(hostLabels: Iterable<string>): boolean {
  let first: string | null = null
  for (const label of hostLabels) {
    if (first === null) {
      first = label
    } else if (label !== first) {
      return true
    }
  }
  return false
}
