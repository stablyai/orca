import type { ClassifiedError } from '../classified-error'
import { GITHUB_SEARCH_RESULT_WINDOW_ERROR_PATTERN } from './work-items-query-bounds'

export function getWorkItemPageErrorTypes(errors: unknown): ClassifiedError['type'][] {
  if (errors === undefined || errors === null) {
    return []
  }
  if (typeof errors !== 'object') {
    return ['unknown']
  }
  const sources = [
    ['issues', 'issues' in errors ? errors.issues : undefined],
    ['prs', 'prs' in errors ? errors.prs : undefined]
  ] as const
  return sources.flatMap(([source, error]): ClassifiedError['type'][] => {
    if (error === undefined || error === null) {
      return []
    }
    if (typeof error !== 'object' || !('type' in error)) {
      return ['unknown']
    }
    switch (error.type) {
      case 'validation_error':
        // Only issue search's 1000-result window proves a page limit.
        return [
          source === 'issues' &&
          'message' in error &&
          typeof error.message === 'string' &&
          GITHUB_SEARCH_RESULT_WINDOW_ERROR_PATTERN.test(error.message)
            ? 'validation_error'
            : 'unknown'
        ]
      case 'permission_denied':
      case 'not_found':
      case 'issues_disabled':
      case 'rate_limited':
      case 'network_error':
        return [error.type]
      default:
        return ['unknown']
    }
  })
}
