export type ClassifiedError = {
  type:
    | 'permission_denied'
    | 'not_found'
    | 'issues_disabled'
    | 'validation_error'
    | 'rate_limited'
    | 'network_error'
    | 'unknown'
  message: string
  /** Copy code for `message`; older hosts omit it. */
  code?: string
  /** Verbatim gh/glab text embedded in `message`. */
  detail?: string
}
