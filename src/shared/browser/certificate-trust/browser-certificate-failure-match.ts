import type {
  BrowserCertificateFailure,
  BrowserCertificateProceedFailureReason,
  BrowserLoadError
} from '../workspaces/browser-workspace-types'
import { normalizeCertificateError } from './browser-certificate-errors'

/** The host's certificate challenge when it is the one this failure shows and can be proceeded past; desktop and phone share the rule. */
export function matchBrowserCertificateFailure(args: {
  loadError: BrowserLoadError
  certificateFailure?: BrowserCertificateFailure | null
  expectedBrowserPageId?: string | null
  canProceed: boolean
}): BrowserCertificateFailure | null {
  const { loadError, certificateFailure, expectedBrowserPageId, canProceed } = args
  const errorMatchesChallenge = Boolean(
    certificateFailure &&
    (loadError.code === -1 ||
      (loadError.code === certificateFailure.errorCode &&
        normalizeCertificateError(certificateFailure.error) ===
          normalizeCertificateError(loadError.description)))
  )
  if (
    !canProceed ||
    !certificateFailure?.canProceed ||
    !expectedBrowserPageId ||
    certificateFailure.browserPageId !== expectedBrowserPageId ||
    certificateFailure.errorCode !== -202 ||
    !errorMatchesChallenge
  ) {
    return null
  }
  try {
    return new URL(loadError.validatedUrl).origin === certificateFailure.origin
      ? certificateFailure
      : null
  } catch {
    return null
  }
}

/** Which sentence explains a certificate failure; each surface words it from its own catalog. */
export function browserCertificateFailureReason(
  code: number
): 'name-mismatch' | 'date-invalid' | 'authority-invalid' | 'unverified' {
  return code === -200
    ? 'name-mismatch'
    : code === -201
      ? 'date-invalid'
      : code === -202
        ? 'authority-invalid'
        : 'unverified'
}

/** Chromium can replace the certificate code with -1 after the host captured the exact challenge; show the challenge's. */
export function browserCertificatePresentationLoadError(
  loadError: BrowserLoadError,
  match: BrowserCertificateFailure | null
): BrowserLoadError {
  return match && loadError.code === -1
    ? { ...loadError, code: match.errorCode ?? loadError.code, description: match.error }
    : loadError
}

/** Which sentence explains a refused Proceed; each surface words it from its own catalog. */
export function browserCertificateProceedFailureKind(
  reason: BrowserCertificateProceedFailureReason | 'request-failed'
): 'expired' | 'changed' | 'request-failed' | 'unavailable' {
  return reason === 'expired'
    ? 'expired'
    : reason === 'changed' || reason === 'navigated'
      ? 'changed'
      : reason === 'request-failed'
        ? 'request-failed'
        : 'unavailable'
}
