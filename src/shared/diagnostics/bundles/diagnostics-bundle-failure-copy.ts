// One English table for diagnostics IPC refusals: main throws the English, the renderer matches it exactly and translates.
export const DIAGNOSTICS_BUNDLE_FAILURE_COPY = {
  creatingDisabled: 'creating review files is disabled',
  sendingDisabled: 'sending diagnostics is disabled',
  sendingNotConfigured: 'sending diagnostics is not configured for this build',
  expiredBeforeSending: 'review file has expired; create a new one before sending',
  expiredBeforeOpening: 'review file has expired; create a new one before opening',
  previewNotOpened: 'open the review file before sending',
  previewOpenFailed: 'could not open review file',
  deleteNotConfigured: 'diagnostic upload endpoint is not configured for this build'
} as const

export type DiagnosticsBundleFailureCode = keyof typeof DIAGNOSTICS_BUNDLE_FAILURE_COPY

export function diagnosticsBundleFailure(code: DiagnosticsBundleFailureCode): Error {
  return new Error(DIAGNOSTICS_BUNDLE_FAILURE_COPY[code])
}
