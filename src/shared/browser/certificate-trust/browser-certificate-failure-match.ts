import type {
  BrowserCertificateFailure,
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
