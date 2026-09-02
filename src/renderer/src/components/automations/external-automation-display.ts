import React from 'react'
import type { Badge } from '@/components/ui/badge'
import type {
  ExternalAutomationManager,
  ExternalAutomationRun
} from '../../../../shared/automations-types'
import { EXTERNAL_AUTOMATION_SCOPE_CODES } from '../../../../shared/external-automation-scope'
import { formatAutomationDateTimeWithRelative } from './automation-page-parts'

export function formatExternalDate(value: string | null, now: number): string {
  if (!value) {
    return 'Never'
  }
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed)) {
    return value
  }
  return formatAutomationDateTimeWithRelative(parsed, now)
}

export function getExternalProviderLabel(manager: ExternalAutomationManager): string {
  return manager.provider === 'hermes' ? 'Hermes' : 'OpenClaw'
}

export function getExternalTargetKindLabel(manager: ExternalAutomationManager): string {
  return manager.target.type === 'ssh' ? 'SSH host' : 'Local'
}

export function getExternalRunStatusLabel(run: ExternalAutomationRun): string {
  switch (run.status) {
    case 'completed':
      return 'Completed'
    case 'failed':
      return 'Failed'
    case 'unknown':
      return 'Unknown'
  }
}

export function getExternalRunStatusVariant(
  run: ExternalAutomationRun
): React.ComponentProps<typeof Badge>['variant'] {
  switch (run.status) {
    case 'completed':
      return 'secondary'
    case 'failed':
      return 'destructive'
    case 'unknown':
      return 'outline'
  }
}

export function getExternalRunContent(run: ExternalAutomationRun): string {
  return run.outputContent ?? run.error ?? run.outputPreview ?? 'No output content available.'
}

export function isMissingExternalRunsApiError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  // The relay path now reports a code, which is exact. The patterns stay for the
  // hosts that answer with no code at all: an unrouted IPC channel, and relays
  // predating the code. Neither can be tightened without losing those hosts.
  return (
    message.includes(EXTERNAL_AUTOMATION_SCOPE_CODES.runsUnsupported) ||
    /listExternalRuns|automations:listExternalRuns|No handler registered/i.test(message)
  )
}
