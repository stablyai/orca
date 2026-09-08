import { getExecutionHostLabel } from '../../../../shared/execution-host'
import type { TaskSourceContext } from '../../../../shared/task-source-context'
import { getTaskProviderIdentityLabel, getTaskProviderLabel } from '../task-provider-labels'

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
  const providerLabel = getTaskProviderLabel(sourceContext.provider)
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
  // A stored identity is authoritative even when it yields no label: falling
  // back to accountLabel here would append a second source to the row.
  if (sourceContext.providerIdentity) {
    return getTaskProviderIdentityLabel(sourceContext.providerIdentity)
  }
  return sourceContext.accountLabel ?? sourceContext.repoId ?? null
}
