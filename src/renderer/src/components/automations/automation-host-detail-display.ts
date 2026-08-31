// The row's catalog entry names the storing authority; the record's own target
// cannot — a runtime-stored automation reads `local`, meaning local to that
// server. That target is only the fallback for a legacy row no host answered for.

import type { Automation } from '../../../../shared/automations-types'
import { getExecutionHostLabel, toSshExecutionHostId } from '../../../../shared/execution-host'
import type { AutomationHostCatalogEntry } from './automation-host-catalog-types'

export type AutomationHostDetailDisplay = {
  label: string
  /** Authority-qualified when the two differ; a self host is its own authority. */
  title: string
}

export function getAutomationHostDetailDisplay(input: {
  automation: Pick<Automation, 'executionTargetType' | 'executionTargetId'>
  entry?: AutomationHostCatalogEntry | null
  hostLabelById?: ReadonlyMap<string, string>
}): AutomationHostDetailDisplay {
  const { automation, entry, hostLabelById } = input
  if (entry) {
    return {
      label: entry.label,
      title:
        entry.authorityLabel === entry.label
          ? entry.label
          : `${entry.authorityLabel} · ${entry.label}`
    }
  }
  const hostId =
    automation.executionTargetType === 'ssh'
      ? toSshExecutionHostId(automation.executionTargetId)
      : 'local'
  const label = hostLabelById?.get(hostId) ?? getExecutionHostLabel(hostId)
  return { label, title: label }
}
