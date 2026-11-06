import { translate } from '@/i18n/i18n'
import {
  BITBUCKET_CONNECT_FAILURE_COPY as EN,
  type BitbucketConnectFailureCode
} from '../../../shared/bitbucket-credentials'

const COPY: Record<BitbucketConnectFailureCode, () => string> = {
  invalidInput: () => translate('codeHost.bitbucketConnect.invalidInput', EN.invalidInput),
  accessTokenRequired: () =>
    translate('codeHost.bitbucketConnect.accessTokenRequired', EN.accessTokenRequired),
  emailAndApiTokenRequired: () =>
    translate('codeHost.bitbucketConnect.emailAndApiTokenRequired', EN.emailAndApiTokenRequired),
  rejected: () => translate('codeHost.bitbucketConnect.rejected', EN.rejected),
  unreachable: () => translate('codeHost.bitbucketConnect.unreachable', EN.unreachable)
}

function isBitbucketConnectFailureCode(code: unknown): code is BitbucketConnectFailureCode {
  return typeof code === 'string' && Object.hasOwn(COPY, code)
}

/** A connect failure in the UI language; uncoded (older host) or unknown codes show the English `error`. */
export function bitbucketConnectErrorText(failure: { error: string; errorCode?: unknown }): string {
  return isBitbucketConnectFailureCode(failure.errorCode)
    ? COPY[failure.errorCode]()
    : failure.error
}
