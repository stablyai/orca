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
}
