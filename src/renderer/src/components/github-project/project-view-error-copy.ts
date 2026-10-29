import { translate } from '@/i18n/i18n'
import type { GitHubProjectViewError } from '../../../../shared/github/project-result-types'

type ProjectViewErrorCopyContext = {
  /** Host of the failing surface, used when an older host omits `error.host`. */
  host?: string
  totalCount?: number
}

// Returns undefined when no reason is set.
function reasonCopy(error: GitHubProjectViewError): string | undefined {
  const detail = error.detail ?? ''
  switch (error.reason) {
    case 'project_or_view_not_found':
      return translate('projectViews.error.projectOrViewNotFound', 'Project or view not found.')
    case 'project_not_found':
      return translate('projectViews.error.projectNotFound', 'Project not found.')
    case 'view_not_found':
      return translate('projectViews.error.viewNotFound', 'Could not find the selected view.')
    case 'owner_not_found':
      return translate('projectViews.error.ownerNotFound', 'Owner not found.')
    case 'item_not_found':
      return translate('projectViews.error.itemNotFound', 'Item not found.')
    case 'issue_not_found':
      return translate('projectViews.error.issueNotFound', 'Issue not found.')
    case 'input_required':
      return translate('projectViews.error.inputRequired', 'Input required.')
    case 'input_too_large':
      return translate(
        'projectViews.error.inputTooLarge',
        'Project reference is too large to resolve.'
      )
    case 'input_unparseable':
      return translate(
        'projectViews.error.inputUnparseable',
        'Could not parse input. Expected a GitHub project URL or `owner/number`.'
      )
    case 'invalid_slug':
      return translate(
        'projectViews.error.invalidSlug',
        'Invalid {{field}}: "{{value}}" is not a valid GitHub slug.',
        { field: detail, value: error.value ?? '' }
      )
    case 'invalid_positive_integer':
      return translate(
        'projectViews.error.invalidPositiveInteger',
        'Invalid {{field}}: must be a positive integer.',
        { field: detail }
      )
    case 'invalid_owner_type':
      return translate('projectViews.error.invalidOwnerType', 'Invalid ownerType.')
    case 'invalid_item_type':
      return translate('projectViews.error.invalidItemType', 'Invalid item type.')
    case 'missing_ids':
      return translate('projectViews.error.missingIds', 'Missing ids.')
    case 'updates_required':
      return translate('projectViews.error.updatesRequired', 'Updates required.')
    case 'comment_body_required':
      return translate('projectViews.error.commentBodyRequired', 'Comment body required.')
    case 'duplicate_target_not_allowed':
      return translate(
        'projectViews.error.duplicateTargetNotAllowed',
        'Duplicate target is only valid when closing as duplicate.'
      )
    case 'duplicate_target_required':
      return translate(
        'projectViews.error.duplicateTargetRequired',
        'Duplicate target issue number is required.'
      )
    case 'request_invalid':
      return translate('projectViews.error.requestInvalid', 'Invalid request — {{detail}}', {
        detail
      })
    case 'request_failed':
      return detail
        ? translate('projectViews.error.requestFailedDetail', 'GitHub request failed: {{detail}}', {
            detail
          })
        : translate('projectViews.error.requestFailed', 'GitHub request failed.')
    case 'unexpected_rest_response':
      return translate(
        'projectViews.error.unexpectedRestResponse',
        'Unexpected REST response: {{detail}}',
        { detail }
      )
    case undefined:
      return undefined
  }
  // A reason from a newer host falls through to the type copy.
  return undefined
}

// Sentences each `type` identifies on its own, so older hosts without `reason` still get them.
function typeCopy(
  error: GitHubProjectViewError,
  context: ProjectViewErrorCopyContext
): string | undefined {
  const host = error.host ?? context.host
  switch (error.type) {
    case 'auth_required':
      return host
        ? translate(
            'projectViews.error.authRequired',
            'Sign in to GitHub to load project tasks. Run `{{command}}`.',
            { command: `gh auth login --hostname ${host}` }
          )
        : undefined
    case 'scope_missing':
      return host
        ? translate(
            'projectViews.error.scopeMissing',
            'GitHub project access needs additional scopes. Run `{{command}}`.',
            { command: `gh auth refresh --hostname ${host} -s project -s read:org -s repo` }
          )
        : undefined
    case 'rate_limited':
      return error.rateLimit
        ? translate(
            'projectViews.error.rateLimitNearlyExhausted',
            'GitHub rate limit nearly exhausted ({{remaining}}/{{limit}} left). Resets in ~{{minutes}}m.',
            {
              remaining: error.rateLimit.remaining,
              limit: error.rateLimit.limit,
              minutes: error.rateLimit.resetMinutes
            }
          )
        : translate(
            'projectViews.error.rateLimited',
            'GitHub rate limit hit. Try again in a few minutes.'
          )
    case 'network_error':
      return translate('projectViews.error.network', 'Network error — check your connection.')
    case 'too_large':
      return context.totalCount === undefined
        ? translate(
            'projectViews.error.tooLargeUnknownCount',
            "This view has too many items to render in Orca. Narrow the view's filter on GitHub."
          )
        : context.totalCount === 1
          ? translate(
              'projectViews.error.tooLargeCount_one',
              "This view has {{count}} item — too large to render in Orca. Narrow the view's filter on GitHub.",
              { count: context.totalCount }
            )
          : translate(
              'projectViews.error.tooLargeCount_other',
              "This view has {{count}} items — too large to render in Orca. Narrow the view's filter on GitHub.",
              { count: context.totalCount }
            )
    case 'unsupported_layout':
      // Older hosts may still reject roadmaps; keep the explanation independent of the requested layout.
      return translate(
        'projectViews.unsupported.description',
        'Orca renders table, board, and roadmap project views. This view uses a layout it cannot render yet.'
      )
    case 'schema_drift':
      return error.detail
        ? translate(
            'projectViews.error.schemaDriftDetail',
            'Could not read this project view: {{detail}}.',
            { detail: error.detail }
          )
        : translate('projectViews.error.schemaDrift', 'Could not read this project view.')
    case 'not_found':
    case 'validation_error':
    case 'unknown':
      return undefined
  }
  return undefined
}

/** Localized copy for a project-view failure; GitHub's own text and unknown failures keep `message`. */
export function projectViewErrorMessage(
  error: GitHubProjectViewError,
  context: ProjectViewErrorCopyContext = {}
): string {
  return reasonCopy(error) ?? typeCopy(error, context) ?? error.message
}
