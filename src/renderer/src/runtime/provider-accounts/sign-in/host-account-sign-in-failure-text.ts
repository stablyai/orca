import { translate } from '@/i18n/i18n'
import {
  HOST_ACCOUNT_SIGN_IN_FAILURE_COPY as FAILURE_EN,
  type HostAccountSignInFailureCode,
  type HostAccountSignInStatus
} from '../../../../../shared/agent-accounts/host-account-sign-in-types'

const FAILURE_COPY: Record<HostAccountSignInFailureCode, () => string> = {
  ownerSilent: () => translate('accounts.hostSignIn.errors.ownerSilent', FAILURE_EN.ownerSilent),
  superseded: () => translate('accounts.hostSignIn.errors.superseded', FAILURE_EN.superseded),
  noPrompt: () => translate('accounts.hostSignIn.errors.noPrompt', FAILURE_EN.noPrompt)
}

function isHostAccountSignInFailureCode(code: unknown): code is HostAccountSignInFailureCode {
  return typeof code === 'string' && Object.hasOwn(FAILURE_COPY, code)
}

/** The host's failure in the UI language; the login's own (uncoded) errors stay verbatim. */
export function hostAccountSignInFailureText(status: HostAccountSignInStatus): string {
  if (isHostAccountSignInFailureCode(status.errorCode)) {
    return FAILURE_COPY[status.errorCode]()
  }
  return (
    status.error ?? translate('accounts.hostSignIn.errors.failed', 'Sign-in failed. Try again.')
  )
}

/** After this client stops waiting for a link: a sign-in the host finished meanwhile still wins. */
export function noPromptOutcome(
  latest: HostAccountSignInStatus | null,
  unprompted: HostAccountSignInStatus
): HostAccountSignInStatus {
  if (latest?.phase === 'signedIn') {
    return latest
  }
  throw new Error(hostAccountSignInFailureText({ ...unprompted, errorCode: 'noPrompt' }))
}
