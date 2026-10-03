import { translate } from '@/i18n/i18n'
import { isUnfinishedClaudeSignIn } from '../../../shared/claude-unfinished-sign-in'
import type { ClaudeManagedAccountSummary } from '../../../shared/managed-account-types'

export type ClaudeAccountRowState = {
  /** The email the account was added as; a draft shows the login its profile holds, if any. */
  label: string
  /** Why the row cannot be used as it is; null for a usable row. */
  problem: string | null
  /** Something to know about a usable account; never blocks it. */
  notice: string | null
  selectable: boolean
}

/** Shared by Settings and the status-bar switcher so both say the same thing about a row. */
export function getClaudeAccountRowState(
  account: ClaudeManagedAccountSummary
): ClaudeAccountRowState {
  const unfinished = isUnfinishedClaudeSignIn(account)
  // Why the added-as email: a row signed in to another login must still say which account it is;
  // its problem text names the login it now holds.
  const label = unfinished
    ? account.profileEmail || translate('accounts.claude.draft', 'Unfinished sign-in')
    : account.email
  const signedInAs = account.profileEmail || account.email
  const readiness = account.profileReadiness
  const addedAsOther =
    !unfinished &&
    !!account.profileEmail &&
    account.profileEmail.toLowerCase() !== account.email.toLowerCase()
  const problem =
    account.profileIdentityIssue === 'duplicate' && addedAsOther
      ? translate(
          'accounts.claude.identityDuplicateAddedAs',
          'This account was added as {{value0}} but is now signed in as {{value1}}, which is already added as another account. Sign in again as {{value0}}, or remove this account.',
          { value0: account.email, value1: signedInAs }
        )
      : account.profileIdentityIssue === 'duplicate'
        ? translate(
            'accounts.claude.identityDuplicate',
            '{{value0}} is already added as another account. Sign in again with a different account, or remove this account.',
            { value0: signedInAs }
          )
        : account.profileIdentityIssue === 'mismatch' &&
            account.profileEmail?.toLowerCase() === account.email.toLowerCase()
          ? translate(
              'accounts.claude.organizationMismatch',
              'This account is now signed in to a different organization. Sign in again to choose which one it uses.'
            )
          : account.profileIdentityIssue === 'mismatch'
            ? translate(
                'accounts.claude.identityMismatch',
                'This account was added as {{value0}} but is now signed in as {{value1}}. Sign in again to choose which account it uses.',
                { value0: account.email, value1: signedInAs }
              )
            : readiness === 'sign-in-required'
              ? unfinished
                ? translate('accounts.claude.finishSignIn', 'Finish signing in to use this account')
                : translate('accounts.claude.signInRequired', 'Sign in again to use this account')
              : readiness === 'unverified'
                ? translate(
                    'accounts.claude.wslNotChecked',
                    'Orca has not checked this account in {{value0}} yet. Selecting it checks it, starting {{value0}} if it is stopped.',
                    { value0: account.wslDistro || 'WSL' }
                  )
                : readiness === 'unavailable'
                  ? account.managedAuthRuntime === 'wsl'
                    ? translate(
                        'accounts.claude.wslUnavailable',
                        'Orca could not check this account in {{value0}}. Select it to try again, or sign in again.',
                        { value0: account.wslDistro || 'WSL' }
                      )
                    : translate(
                        'accounts.claude.profileUnreadable',
                        "This account's files could not be read. Try again, or sign in again."
                      )
                  : null
  const notice =
    account.profileSetupIssue === 'hooks'
      ? translate(
          'accounts.claude.setupHooks',
          "Orca's status hooks could not be added to this account, so its agent status may not update."
        )
      : account.profileSetupIssue === 'links'
        ? translate(
            'accounts.claude.setupLinks',
            'Some shared Claude settings could not be linked into this account.'
          )
        : account.profileSetupIssue === 'private-history'
          ? translate(
              'accounts.claude.setupPrivateHistory',
              "This account's chat history is kept separate because it is on a different drive."
            )
          : null
  return {
    label,
    problem,
    notice,
    // Why these pass: an older host reports no readiness, and selecting a WSL account starts its
    // distro and checks it, refusing with its own reason if it still cannot be used.
    selectable:
      (readiness === undefined ||
        readiness === 'ready' ||
        (account.managedAuthRuntime === 'wsl' &&
          (readiness === 'unverified' || readiness === 'unavailable'))) &&
      !account.profileIdentityIssue
  }
}
