import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import type { GitHubProjectViewError } from '../../../../shared/github/project-result-types'

type ProjectViewErrorCopyContext = {
  /** Host of the failing surface, used when an older host omits `error.host`. */
  host?: string
  totalCount?: number
}

// Returns undefined when no reason is set.
function reasonCopy(error: GitHubProjectViewError, t: Translate = translate): string | undefined {
  const detail = error.detail ?? ''
  switch (error.reason) {
    case 'project_or_view_not_found':
      return t('projectViews.error.projectOrViewNotFound', 'Project or view not found.')
    case 'project_not_found':
      return t('projectViews.error.projectNotFound', 'Project not found.')
    case 'view_not_found':
      return t('projectViews.error.viewNotFound', 'Could not find the selected view.')
    case 'owner_not_found':
      return t('projectViews.error.ownerNotFound', 'Owner not found.')
    case 'item_not_found':
      return t('projectViews.error.itemNotFound', 'Item not found.')
    case 'issue_not_found':
      return t('projectViews.error.issueNotFound', 'Issue not found.')
    case 'input_required':
      return t('projectViews.error.inputRequired', 'Input required.')
    case 'input_too_large':
      return t('projectViews.error.inputTooLarge', 'Project reference is too large to resolve.')
    case 'input_unparseable':
      return t(
        'projectViews.error.inputUnparseable',
        'Could not parse input. Expected a GitHub project URL or `owner/number`.'
      )
    case 'invalid_slug':
      return t(
        'projectViews.error.invalidSlug',
        'Invalid {{field}}: "{{value}}" is not a valid GitHub slug.',
        { field: detail, value: error.value ?? '' }
      )
    case 'invalid_positive_integer':
      return t(
        'projectViews.error.invalidPositiveInteger',
        'Invalid {{field}}: must be a positive integer.',
        { field: detail }
      )
    case 'invalid_owner_type':
      return t('projectViews.error.invalidOwnerType', 'Invalid ownerType.')
    case 'invalid_item_type':
      return t('projectViews.error.invalidItemType', 'Invalid item type.')
    case 'missing_ids':
      return t('projectViews.error.missingIds', 'Missing ids.')
    case 'updates_required':
      return t('projectViews.error.updatesRequired', 'Updates required.')
    case 'comment_body_required':
      return t('projectViews.error.commentBodyRequired', 'Comment body required.')
    case 'duplicate_target_not_allowed':
      return t(
        'projectViews.error.duplicateTargetNotAllowed',
        'Duplicate target is only valid when closing as duplicate.'
      )
    case 'duplicate_target_required':
      return t(
        'projectViews.error.duplicateTargetRequired',
        'Duplicate target issue number is required.'
      )
    case 'request_invalid':
      return t('projectViews.error.requestInvalid', 'Invalid request — {{detail}}', {
        detail
      })
    case 'request_failed':
      return detail
        ? t('projectViews.error.requestFailedDetail', 'GitHub request failed: {{detail}}', {
            detail
          })
        : t('projectViews.error.requestFailed', 'GitHub request failed.')
    case 'unexpected_rest_response':
      return t(
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
  context: ProjectViewErrorCopyContext,
  t: Translate = translate
): string | undefined {
  const host = error.host ?? context.host
  switch (error.type) {
    case 'auth_required':
      return host
        ? t(
            'projectViews.error.authRequired',
            'Sign in to GitHub to load project tasks. Run `{{command}}`.',
            { command: `gh auth login --hostname ${host}` }
          )
        : undefined
    case 'scope_missing':
      return host
        ? t(
            'projectViews.error.scopeMissing',
            'GitHub project access needs additional scopes. Run `{{command}}`.',
            { command: `gh auth refresh --hostname ${host} -s project -s read:org -s repo` }
          )
        : undefined
    case 'rate_limited':
      return error.rateLimit
        ? t(
            'projectViews.error.rateLimitNearlyExhausted',
            'GitHub rate limit nearly exhausted ({{remaining}}/{{limit}} left). Resets in ~{{minutes}}m.',
            {
              remaining: error.rateLimit.remaining,
              limit: error.rateLimit.limit,
              minutes: error.rateLimit.resetMinutes
            }
          )
        : t('projectViews.error.rateLimited', 'GitHub rate limit hit. Try again in a few minutes.')
    case 'network_error':
      return t('projectViews.error.network', 'Network error — check your connection.')
    case 'too_large':
      return context.totalCount === undefined
        ? t(
            'projectViews.error.tooLargeUnknownCount',
            "This view has too many items to render in Orca. Narrow the view's filter on GitHub."
          )
        : t(
            'projectViews.error.tooLargeCount',
            "This view has {{count}} items — too large to render in Orca. Narrow the view's filter on GitHub.",
            {
              count: context.totalCount,
              defaultValue_one:
                "This view has {{count}} item — too large to render in Orca. Narrow the view's filter on GitHub."
            }
          )
    case 'unsupported_layout':
      // Older hosts may still reject roadmaps; keep the explanation independent of the requested layout.
      return t(
        'projectViews.unsupported.description',
        'Orca renders table, board, and roadmap project views. This view uses a layout it cannot render yet.'
      )
    case 'schema_drift':
      return error.detail
        ? t(
            'projectViews.error.schemaDriftDetail',
            'Could not read this project view: {{detail}}.',
            { detail: error.detail }
          )
        : t('projectViews.error.schemaDrift', 'Could not read this project view.')
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
  context: ProjectViewErrorCopyContext = {},
  t?: Translate
): string {
  return reasonCopy(error, t) ?? typeCopy(error, context, t) ?? error.message
}
