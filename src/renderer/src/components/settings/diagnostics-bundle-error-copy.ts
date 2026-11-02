import { translate } from '@/i18n/i18n'
import { displayIpcErrorMessage } from '@/lib/ipc-error'
import {
  DIAGNOSTICS_BUNDLE_FAILURE_COPY as EN,
  type DiagnosticsBundleFailureCode
} from '../../../../shared/diagnostics-bundle-failure-copy'

const COPY: Record<DiagnosticsBundleFailureCode, () => string> = {
  creatingDisabled: () =>
    translate('settings.diagnostics.errors.creatingDisabled', EN.creatingDisabled),
  sendingDisabled: () =>
    translate('settings.diagnostics.errors.sendingDisabled', EN.sendingDisabled),
  sendingNotConfigured: () =>
    translate('settings.diagnostics.errors.sendingNotConfigured', EN.sendingNotConfigured),
  expiredBeforeSending: () =>
    translate('settings.diagnostics.errors.expiredBeforeSending', EN.expiredBeforeSending),
  expiredBeforeOpening: () =>
    translate('settings.diagnostics.errors.expiredBeforeOpening', EN.expiredBeforeOpening),
  previewNotOpened: () =>
    translate('settings.diagnostics.errors.previewNotOpened', EN.previewNotOpened),
  previewOpenFailed: () =>
    translate('settings.diagnostics.errors.previewOpenFailed', EN.previewOpenFailed),
  deleteNotConfigured: () =>
    translate('settings.diagnostics.errors.deleteNotConfigured', EN.deleteNotConfigured)
}

// Main and renderer ship together, so the shared English sentence identifies the refusal.
function isDiagnosticsBundleFailureCode(code: string): code is DiagnosticsBundleFailureCode {
  return Object.hasOwn(COPY, code)
}

const CODE_BY_ENGLISH = new Map(
  Object.entries(EN).flatMap(([code, text]): [string, DiagnosticsBundleFailureCode][] =>
    isDiagnosticsBundleFailureCode(code) ? [[text, code]] : []
  )
)

/** Translates known diagnostics refusals; other errors show their unwrapped text. */
export function diagnosticsErrorText(error: unknown, fallback: string): string {
  if (!(error instanceof Error) || !error.message) {
    return fallback
  }
  const message = displayIpcErrorMessage(error.message) ?? error.message
  const code = CODE_BY_ENGLISH.get(message)
  return code === undefined ? message : COPY[code]()
}
