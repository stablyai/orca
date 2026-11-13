// X1: why the one-trip setup stopped, inside the setup panel. Neutral when nothing failed (the
// browser was closed, Checkout canceled, the bank wants a step); an error only when creating the
// team failed. Finished steps stay done, the prompt stays in the composer, and no codes are shown.
import React from 'react'
import { Button } from '@/components/ui/button'
import { OpenExternalSplitButton } from '@/components/open-external/OpenExternalSplitButton'
import type { ExternalLinkSource } from '@/components/open-external/copy-external-link'
import { InlineError } from '@/components/ui/inline-error'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import {
  cloudSetupErrorAction,
  cloudSetupErrorTone,
  type CloudSetupError,
  type CloudSetupErrorAction
} from './cloud-setup-errors'

function errorTitle(error: CloudSetupError, canManageBilling: boolean, t: Translate): string {
  switch (error.kind) {
    case 'timed_out':
      return t(
        'components.newWorkspace.cloudSetup.error.timedOut',
        'Setup didn’t finish in your browser. Your prompt is still here.'
      )
    case 'checkout_canceled':
      return t(
        'components.newWorkspace.cloudSetup.error.checkoutCanceled',
        'Checkout canceled. Nothing was charged.'
      )
    case 'bank_step':
      return t(
        'components.newWorkspace.cloudSetup.error.bankStep',
        'Your bank needs one more step. Finish it in your browser.'
      )
    case 'trial_unavailable':
      return canManageBilling
        ? t(
            'components.newWorkspace.cloudSetup.error.trialUnavailable',
            'This account or team already used its trial. Choose a plan to use Orca Cloud.'
          )
        : t(
            'components.newWorkspace.cloudSetup.error.trialUnavailableMember',
            'This account or team already used its trial. Ask an owner or admin to choose a plan.'
          )
    case 'team_create_failed':
      return t(
        'components.newWorkspace.cloudSetup.error.teamCreateFailed',
        'Couldn’t create the team. Nothing was created, and you weren’t charged.'
      )
    case 'wrong_account':
      return error.detail && error.teamName
        ? t(
            'components.newWorkspace.cloudSetup.error.wrongAccount',
            'Signed in as {{email}}, who isn’t on {{team}}. Switch accounts or ask an owner of {{team}} for an invite.',
            { email: error.detail, team: error.teamName }
          )
        : t(
            'components.newWorkspace.cloudSetup.error.wrongAccountGeneric',
            'Signed in with an account that isn’t on this team. Switch accounts or ask an owner for an invite.'
          )
  }
}

function actionLabel(action: CloudSetupErrorAction, t: Translate): string {
  switch (action) {
    case 'reopen-browser':
      return t('components.newWorkspace.cloudSetup.reopenBrowser', 'Reopen browser')
    case 'try-again':
      return t('components.newWorkspace.cloudSetup.tryAgain', 'Try again')
    case 'choose-plan':
      return t('components.newWorkspace.cloudSetup.choosePlan', 'Choose plan')
    case 'switch-account':
      return t('components.newWorkspace.cloudSetup.switchAccount', 'Switch account')
  }
}

export function CloudSetupErrorNotice({
  error,
  canManageBilling = true,
  reopenLink,
  onAction,
  className
}: {
  error: CloudSetupError
  /** Members can't choose a plan: the trial notice then names who can, with no button. */
  canManageBilling?: boolean
  /** Reopen browser's page (a fresh setup link): its chevron offers "Copy link". */
  reopenLink?: ExternalLinkSource | null
  onAction: (action: CloudSetupErrorAction) => void
  className?: string
}): React.JSX.Element {
  const t = useTranslate()
  const action = cloudSetupErrorAction(error.kind)
  const showAction = action !== 'choose-plan' || canManageBilling
  return (
    <InlineError
      // Re-announce when the kind changes; the same kind twice stays one announcement.
      key={error.kind}
      density="compact"
      tone={cloudSetupErrorTone(error.kind)}
      title={errorTitle(error, canManageBilling, t)}
      action={
        showAction ? (
          action === 'reopen-browser' && reopenLink ? (
            <OpenExternalSplitButton
              variant="outline"
              size="xs"
              link={reopenLink}
              onClick={() => onAction(action)}
            >
              {actionLabel(action, t)}
            </OpenExternalSplitButton>
          ) : (
            <Button type="button" variant="outline" size="xs" onClick={() => onAction(action)}>
              {actionLabel(action, t)}
            </Button>
          )
        ) : undefined
      }
      className={className}
    />
  )
}
