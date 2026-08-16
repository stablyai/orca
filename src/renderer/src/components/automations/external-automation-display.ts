import React from 'react'
import type { Badge } from '@/components/ui/badge'
import type {
  ExternalAutomationJob,
  ExternalAutomationManager,
  ExternalAutomationRun
} from '../../../../shared/automations-types'
import { formatAutomationDateTimeWithRelative } from './automation-page-parts'

export function getExternalAutomationKey(
  manager: ExternalAutomationManager,
  job: ExternalAutomationJob
): string {
  return `${manager.id}:${job.id}`
}

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
  return /listExternalRuns|automations:listExternalRuns|No handler registered/i.test(message)
}
