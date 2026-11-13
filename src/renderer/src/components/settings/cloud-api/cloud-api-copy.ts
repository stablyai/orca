// Wording for Orca Cloud API results: error codes from main become sentences people can act on.
import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import type {
  CloudApiErrorCode,
  CloudApiScope,
  RoutineRunStatus,
  RoutineRunTrigger
} from '../../../../../shared/cloud-api/cloud-api-types'

export function cloudApiErrorCopy(
  error: CloudApiErrorCode,
  t: Translate = translate,
  options: { detail?: string; retryAfterSeconds?: number } = {}
): string {
  switch (error) {
    case 'unconfigured':
      return t(
        'auto.components.settings.cloudApi.error.unconfigured',
        'Orca Cloud is not available in this build.'
      )
    case 'signed-out':
      return t(
        'auto.components.settings.cloudApi.error.signedOut',
        'Sign in to Orca to manage Orca Cloud access.'
      )
    case 'admin-required':
      return t(
        'auto.components.settings.cloudApi.error.adminRequired',
        'Only a team owner or admin can do this.'
      )
    case 'plan-required':
      return t(
        'auto.components.settings.cloudApi.error.planRequired',
        'Your team’s plan doesn’t include this.'
      )
    case 'forbidden':
      return t(
        'auto.components.settings.cloudApi.error.forbidden',
        'Your account does not have permission to do this.'
      )
    case 'not-found':
      return t(
        'auto.components.settings.cloudApi.error.notFound',
        'It no longer exists. Refresh to see the latest.'
      )
    case 'not-available':
      return t(
        'auto.components.settings.cloudApi.error.notAvailable',
        'Orca Cloud does not offer this yet. Try again after the next update.'
      )
    case 'invalid-request':
      // Server reasons that are bare machine codes ("project_name_taken") read as noise; show
      // only human sentences (validation messages like "name: Too small").
      return options.detail && /\s/.test(options.detail)
        ? t(
            'auto.components.settings.cloudApi.error.invalidWithDetail',
            'Orca Cloud rejected that: {{reason}}',
            { reason: options.detail }
          )
        : t(
            'auto.components.settings.cloudApi.error.invalid',
            'Orca Cloud rejected that request. Check the fields and try again.'
          )
    case 'rate-limited':
      return options.retryAfterSeconds
        ? t(
            'auto.components.settings.cloudApi.error.rateLimitedFor',
            'Too many requests. Try again in {{seconds}} seconds.',
            { seconds: String(options.retryAfterSeconds) }
          )
        : t(
            'auto.components.settings.cloudApi.error.rateLimited',
            'Too many requests. Try again in a minute.'
          )
    case 'network':
      return t(
        'auto.components.settings.cloudApi.error.network',
        'Couldn’t reach Orca Cloud. Check your connection and try again.'
      )
    case 'invalid-response':
      return t(
        'auto.components.settings.cloudApi.error.invalidResponse',
        'Orca Cloud sent an answer this version of Orca does not understand. Update Orca and try again.'
      )
    case 'server':
      return t(
        'auto.components.settings.cloudApi.error.server',
        'Orca Cloud had a problem and nothing was changed. Try again in a moment.'
      )
  }
}

export function cloudApiScopeDescription(scope: CloudApiScope, t: Translate = translate): string {
  switch (scope) {
    case 'workspaces:read':
      return t(
        'auto.components.settings.cloudApi.scope.workspacesRead',
        'List and inspect workspaces'
      )
    case 'workspaces:write':
      return t(
        'auto.components.settings.cloudApi.scope.workspacesWrite',
        'Create, wake, sleep and delete workspaces'
      )
    case 'messages:write':
      return t('auto.components.settings.cloudApi.scope.messagesWrite', 'Send prompts to agents')
    case 'projects:read':
      return t('auto.components.settings.cloudApi.scope.projectsRead', 'List projects')
    case 'projects:write':
      return t('auto.components.settings.cloudApi.scope.projectsWrite', 'Create and edit projects')
    case 'routines:read':
      return t(
        'auto.components.settings.cloudApi.scope.routinesRead',
        'List routines and their runs'
      )
    case 'routines:write':
      return t(
        'auto.components.settings.cloudApi.scope.routinesWrite',
        'Create, edit and run routines'
      )
    case 'audit:read':
      return t('auto.components.settings.cloudApi.scope.auditRead', 'Read the team audit log')
  }
}

export function routineRunStatusLabel(status: RoutineRunStatus, t: Translate = translate): string {
  switch (status) {
    case 'queued':
      return t('auto.components.settings.cloudRoutines.status.queued', 'Queued')
    case 'starting':
      return t('auto.components.settings.cloudRoutines.status.starting', 'Starting')
    case 'running':
      return t('auto.components.settings.cloudRoutines.status.running', 'Running')
    case 'posting':
      return t('auto.components.settings.cloudRoutines.status.posting', 'Posting results')
    case 'succeeded':
      return t('auto.components.settings.cloudRoutines.status.succeeded', 'Succeeded')
    case 'failed':
      return t('auto.components.settings.cloudRoutines.status.failed', 'Failed')
    case 'cancelled':
      return t('auto.components.settings.cloudRoutines.status.cancelled', 'Canceled')
    case 'timed_out':
      return t('auto.components.settings.cloudRoutines.status.timedOut', 'Timed out')
  }
}

export type RoutineRunTone = 'active' | 'success' | 'failure' | 'neutral'

export function routineRunTone(status: RoutineRunStatus): RoutineRunTone {
  if (status === 'succeeded') {
    return 'success'
  }
  if (status === 'failed' || status === 'timed_out') {
    return 'failure'
  }
  if (status === 'cancelled') {
    return 'neutral'
  }
  return 'active'
}

export function routineRunTriggerLabel(
  trigger: RoutineRunTrigger,
  t: Translate = translate
): string {
  switch (trigger) {
    case 'schedule':
      return t('auto.components.settings.cloudRoutines.runTrigger.schedule', 'Schedule')
    case 'github':
      return t('auto.components.settings.cloudRoutines.runTrigger.github', 'GitHub')
    case 'webhook':
      return t('auto.components.settings.cloudRoutines.runTrigger.webhook', 'Webhook')
    case 'manual':
      return t('auto.components.settings.cloudRoutines.runTrigger.manual', 'Manual')
  }
}

/**
 * A run's failure in plain words. The control plane sends a code, sometimes with detail after a
 * colon ("workspace_lost:suspended"); codes and detail never reach the screen.
 */
export function routineRunErrorCopy(error: string, t: Translate = translate): string {
  return describeRoutineRunError(error, t).text
}

/**
 * Copy plus tone: things that went wrong (couldn't start, couldn't post, interrupted, unknown) are
 * errors; outcomes that are expected bookkeeping (skipped, superseded, workspace gone) are neutral.
 */
export function describeRoutineRunError(
  error: string,
  t: Translate = translate
): { text: string; tone: 'error' | 'neutral' } {
  const neutral = (text: string) => ({ text, tone: 'neutral' as const })
  const failure = (text: string) => ({ text, tone: 'error' as const })
  const code = error.split(':', 1)[0]?.trim() ?? ''
  if (code === 'start_failed') {
    return failure(
      t(
        'auto.components.settings.cloudRoutines.runError.startFailed',
        'The workspace couldn’t start, so nothing was charged.'
      )
    )
  }
  if (code === 'workspace_lost') {
    return neutral(
      t(
        'auto.components.settings.cloudRoutines.runError.workspaceLost',
        'The workspace went to sleep or was deleted before the run finished.'
      )
    )
  }
  if (code === 'post_failed') {
    return failure(
      t(
        'auto.components.settings.cloudRoutines.runError.postFailed',
        'The run finished, but Orca couldn’t post the results.'
      )
    )
  }
  if (code === 'queue_expired') {
    return neutral(
      t(
        'auto.components.settings.cloudRoutines.runError.queueExpired',
        'The run waited too long to start and was skipped.'
      )
    )
  }
  if (code.endsWith('_interrupted')) {
    return failure(
      t(
        'auto.components.settings.cloudRoutines.runError.interrupted',
        'Orca Cloud restarted during the run.'
      )
    )
  }
  if (code === 'routine_changed') {
    return neutral(
      t(
        'auto.components.settings.cloudRoutines.runError.routineChanged',
        'The routine changed while this run was queued.'
      )
    )
  }
  return failure(t('auto.components.settings.cloudRoutines.runError.generic', 'The run failed.'))
}
