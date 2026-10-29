import { translate } from '@/i18n/i18n'
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
    translate(
      'auto.components.taskSourceContextSummary.providerSourceTitle',
      '{{provider}} source',
      { provider: providerLabel }
    ),
    translate('auto.components.taskSourceContextSummary.hostTitle', 'Host: {{hosts}}', {
      hosts: hostLabel
    }),
    sourceContext.accountLabel
      ? translate(
          'auto.components.taskSourceContextSummary.accountTitle',
          'Account: {{accounts}}',
          { accounts: sourceContext.accountLabel }
        )
      : null,
    identityLabel
      ? translate('auto.components.taskSourceContextSummary.sourceTitle', 'Source: {{source}}', {
          source: identityLabel
        })
      : null
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
