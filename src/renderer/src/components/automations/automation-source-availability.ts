import type { TaskSourceContext } from '../../../../shared/task-source-context'
import type { TaskSourceHostAvailability } from '../task-source-context-summary'
import type { AutomationTargetAvailability } from './automation-target-availability'

function unavailable(
  reason: Exclude<AutomationTargetAvailability['reason'], 'available'>,
  message: string
): AutomationTargetAvailability {
  return { canRunNow: false, reason, message }
}

/** Blocks a manual run whose saved task-source host cannot serve it right now. */
export function getAutomationSourceAvailability(
  sourceContext: TaskSourceContext | null | undefined,
  sourceHostAvailability: readonly TaskSourceHostAvailability[] | undefined
): AutomationTargetAvailability | null {
  if (!sourceContext) {
    return null
  }
  const availability = sourceHostAvailability?.find(
    (entry) => entry.hostId === sourceContext.hostId
  )
  if (!availability) {
    return null
  }
  const providerLabel = getAutomationSourceProviderLabel(sourceContext.provider)
  switch (availability.reason) {
    case undefined:
      break
    case 'missing-provider-auth':
      return unavailable(
        'source-auth-needed',
        `Connect the saved ${providerLabel} source account before running manually.`
      )
    case 'unavailable-source-tool':
      return unavailable(
        'source-tool-unavailable',
        `Install or configure the ${providerLabel} source tool before running manually.`
      )
    case 'unsupported-provider':
    case 'missing-task-source-capability':
      return unavailable(
        'source-provider-unsupported',
        `The saved ${providerLabel} source is not supported on this automation host.`
      )
    case 'checking-task-source-capability':
      return unavailable(
        'source-host-unavailable',
        `Checking the saved ${providerLabel} source host before running manually.`
      )
  }
  if (
    availability.health === 'disconnected' ||
    availability.health === 'blocked' ||
    availability.health === 'error' ||
    availability.status === 'disconnected' ||
    availability.status === 'auth-failed' ||
    availability.status === 'reconnection-failed' ||
    availability.status === 'error'
  ) {
    return unavailable(
      'source-host-unavailable',
      `Reconnect the saved ${providerLabel} source host before running manually.`
    )
  }
  if (
    availability.health === 'connecting' ||
    availability.status === 'connecting' ||
    availability.status === 'deploying-relay' ||
    availability.status === 'reconnecting'
  ) {
    return unavailable(
      'source-host-unavailable',
      `The saved ${providerLabel} source host is still connecting.`
    )
  }
  return null
}

function getAutomationSourceProviderLabel(provider: TaskSourceContext['provider']): string {
  switch (provider) {
    case 'github':
      return 'GitHub'
    case 'gitlab':
      return 'GitLab'
    case 'linear':
      return 'Linear'
    case 'jira':
      return 'Jira'
  }
}
