// Maps closed reason codes to localized, user-safe messages. This is the
// ONLY place select-task/list-load failures become renderer-visible text —
// never a raw exception message, path, command string, or Git stderr. See
// plan §10.2/§10.3 (privacy boundaries) and ipc/audited-workflow.ts (where
// the reason codes are produced instead of thrown raw errors).
import { translate } from '@/i18n/i18n'
import type { SelectTaskReasonCode } from '../../../../shared/audited-workflow-types'

export function getSelectTaskErrorMessage(reasonCode: SelectTaskReasonCode): string {
  switch (reasonCode) {
    case 'repo_not_found':
      return translate(
        'auto.components.auditedWorkflow.errors.repoNotFound',
        'That repository could not be found. Refresh and try again.'
      )
    case 'unsupported_host':
      return translate(
        'auto.components.auditedWorkflow.errors.unsupportedHost',
        'Audited Workflow currently supports local Git repositories only.'
      )
    case 'git_resolution_failed':
      return translate(
        'auto.components.auditedWorkflow.errors.gitResolutionFailed',
        'Could not read the repository. Make sure it is a valid Git repository and try again.'
      )
    case 'internal_error':
      return translate(
        'auto.components.auditedWorkflow.errors.internalError',
        'Something went wrong creating the task. Please try again.'
      )
  }
}

export function getTaskListErrorMessage(): string {
  return translate(
    'auto.components.auditedWorkflow.errors.listLoadFailed',
    'Could not load audited tasks.'
  )
}
