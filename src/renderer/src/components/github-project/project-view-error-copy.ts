import type {
  GitHubProjectViewError,
  GitHubProjectViewErrorReason
} from '../../../../shared/github/project-result-types'
import {
  projectGhLoginCommand,
  projectGhRefreshCommand
} from '../../../../shared/github/project-gh-auth-commands'
import { translate } from '@/i18n/i18n'

/** Same sentence as the shared `GITHUB_PROJECT_REF_INPUT_TOO_LARGE_ERROR`, in the UI language. */
export function projectRefInputTooLargeMessage(): string {
  return translate(
    'projectViews.errors.inputTooLarge',
    'Project reference is too large to resolve.'
  )
}

/** Returns undefined when the host left out a value the sentence needs. */
function reasonMessage(
  error: GitHubProjectViewError,
  reason: GitHubProjectViewErrorReason
): string | undefined {
  const { diagnostic } = error
  switch (reason) {
    case 'project_not_found':
      return translate('projectViews.errors.projectNotFound', 'Project not found.')
    case 'owner_not_found':
      return translate('projectViews.errors.ownerNotFound', 'Owner not found.')
    case 'view_not_found':
      return translate('projectViews.errors.viewNotFound', 'Could not find the selected view.')
    case 'issue_not_found':
      return translate('projectViews.errors.issueNotFound', 'Issue not found.')
    case 'item_not_found':
      return translate('projectViews.errors.itemNotFound', 'Item not found.')
    case 'project_or_view_not_found':
      return translate('projectViews.errors.projectOrViewNotFound', 'Project or view not found.')
    case 'rate_limit_hit':
      return translate(
        'projectViews.errors.rateLimitHit',
        'GitHub rate limit hit. Try again in a few minutes.'
      )
    case 'input_required':
      return translate('projectViews.errors.inputRequired', 'Input required.')
    case 'input_too_large':
      return projectRefInputTooLargeMessage()
    case 'input_unparseable':
      return translate(
        'projectViews.errors.inputUnparseable',
        'Could not parse input. Expected a GitHub project URL or `owner/number`.'
      )
    case 'cli_not_authenticated':
      return error.host
        ? translate(
            'projectViews.errors.cliNotAuthenticated',
            'GitHub CLI is not authenticated to {{host}}. Run {{command}}.',
            { host: error.host, command: projectGhLoginCommand(error.host) }
          )
        : undefined
    case 'invalid_request':
      return diagnostic === undefined
        ? undefined
        : translate('projectViews.errors.invalidRequest', 'Invalid request — {{diagnostic}}', {
            diagnostic
          })
    case 'request_failed':
      return diagnostic
        ? translate(
            'projectViews.errors.requestFailedWithDetail',
            'GitHub request failed: {{diagnostic}}',
            { diagnostic }
          )
        : translate('projectViews.errors.requestFailed', 'GitHub request failed.')
    case 'unexpected_rest_response':
      return diagnostic === undefined
        ? undefined
        : translate(
            'projectViews.errors.unexpectedRestResponse',
            'Unexpected REST response: {{diagnostic}}',
            { diagnostic }
          )
  }
}

/** For errors without a reason, where the type and its fields name the sentence. */
function typeMessage(error: GitHubProjectViewError): string | undefined {
  switch (error.type) {
    case 'auth_required':
      return error.host
        ? translate(
            'projectViews.errors.signInRequired',
            'Sign in to GitHub to load project tasks. Run `{{command}}`.',
            { command: projectGhLoginCommand(error.host) }
          )
        : undefined
    case 'scope_missing':
      return error.host
        ? translate(
            'projectViews.errors.scopeMissing',
            'GitHub project access needs additional scopes. Run `{{command}}`.',
            { command: projectGhRefreshCommand(error.host) }
          )
        : undefined
    case 'rate_limited':
      return error.rateLimit
        ? translate(
            'projectViews.errors.rateLimitLow',
            'GitHub rate limit nearly exhausted ({{remaining}}/{{limit}} left). Resets in ~{{minutes}}m.',
            {
              remaining: error.rateLimit.remaining,
              limit: error.rateLimit.limit,
              minutes: error.rateLimit.resetMinutes
            }
          )
        : undefined
    case 'network_error':
      return translate('projectViews.errors.network', 'Network error — check your connection.')
    case 'schema_drift':
      return error.diagnostic === undefined
        ? undefined
        : translate(
            'projectViews.errors.schemaDrift',
            'Could not read this project view: {{diagnostic}}.',
            { diagnostic: error.diagnostic }
          )
    // Several sentences share these types, so only a reason names one; the error state renders the last two.
    case 'not_found':
    case 'validation_error':
    case 'unknown':
    case 'too_large':
    case 'unsupported_layout':
      return undefined
  }
}

/** The project view failure in the UI language; GitHub's own text and the copy of older or newer hosts stay as sent. */
export function projectViewErrorMessage(error: GitHubProjectViewError): string {
  // A newer host's reason can name a sentence this build lacks; the type's generic copy would misstate it.
  if (error.reason !== undefined) {
    return reasonMessage(error, error.reason) ?? error.message
  }
  return typeMessage(error) ?? error.message
}
