import { getExecutionHostLabel } from '../../../../shared/execution-host'
import type { TaskSourceContext } from '../../../../shared/task-source-context'
import {
  getTaskProviderIdentityLabel,
  getTaskSourceProviderLabel
} from '../task-source-provider-label'

export type AutomationSourceDisplay = {
  label: string
  title: string
}

export function getAutomationSourceDisplay(
  sourceContext: TaskSourceContext | null | undefined,
  hostLabelById?: ReadonlyMap<string, string>
): AutomationSourceDisplay | null {
  if (!sourceContext) {
    return null
  }
  const providerLabel = getTaskSourceProviderLabel(sourceContext.provider)
  const hostLabel =
    hostLabelById?.get(sourceContext.hostId) ?? getExecutionHostLabel(sourceContext.hostId)
  const identityLabel = getSourceIdentityLabel(sourceContext)
  const label = [providerLabel, hostLabel, identityLabel]
    .filter((part): part is string => Boolean(part))
    .join(' · ')
  const title = [
    `${providerLabel} source`,
    `Host: ${hostLabel}`,
    sourceContext.accountLabel ? `Account: ${sourceContext.accountLabel}` : null,
    identityLabel ? `Source: ${identityLabel}` : null
  ]
    .filter((part): part is string => Boolean(part))
    .join(' · ')
  return { label, title }
}

function getSourceIdentityLabel(sourceContext: TaskSourceContext): string | null {
  return (
    getTaskProviderIdentityLabel(sourceContext.providerIdentity) ??
    sourceContext.accountLabel ??
    sourceContext.repoId ??
    null
  )
}
