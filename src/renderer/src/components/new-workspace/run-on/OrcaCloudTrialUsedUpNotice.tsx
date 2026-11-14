// T4: the trial runs out while workspaces exist. Running sandboxes go to sleep; owners choose a plan,
// members ask for one in the app (O6). Neutral: nothing failed and nothing is deleted.
import React from 'react'
import { Button } from '@/components/ui/button'
import { InlineError } from '@/components/ui/inline-error'
import { useTranslate } from '@/i18n/use-translate'
import { openCloudConsole } from '@/lib/orca-cloud/open-cloud-console'
import { useOrcaCloudRunTargetAccess } from '../orca-cloud-billing-cache'

export function OrcaCloudTrialUsedUpNotice({
  canManageBilling,
  teamName,
  onAskForPlan,
  className
}: {
  canManageBilling: boolean
  teamName?: string
  /** The member's in-app request (np4-requests); without it the member line names who can act. */
  onAskForPlan?: () => void
  className?: string
}): React.JSX.Element {
  const t = useTranslate()
  const asleep = t(
    'components.newWorkspace.trialUsedUp.running',
    'Running sandboxes go to sleep and new ones can’t start. Nothing is deleted, and your files are safe.'
  )
  const title = canManageBilling
    ? t('components.newWorkspace.cloudSetup.trialUsedUpTitle', 'Your trial is used up')
    : teamName
      ? t('components.newWorkspace.trialUsedUp.memberTitle', '{{team}}’s trial is used up', {
          team: teamName
        })
      : t('components.newWorkspace.trialUsedUp.memberTitleNoTeam', 'Your team’s trial is used up')
  const action = canManageBilling ? (
    <Button
      type="button"
      variant="outline"
      size="xs"
      onClick={() => void openCloudConsole('billing')}
    >
      {t('components.newWorkspace.cloudSetup.choosePlan', 'Choose plan')}
    </Button>
  ) : onAskForPlan ? (
    <Button type="button" variant="outline" size="xs" onClick={onAskForPlan}>
      {t('components.newWorkspace.trialUsedUp.askForPlan', 'Ask for a Team plan')}
    </Button>
  ) : undefined
  return (
    <InlineError
      tone="neutral"
      title={title}
      detail={
        canManageBilling
          ? asleep
          : `${asleep} ${t(
              'components.newWorkspace.cloudSetup.askChoosePlan',
              'Ask an owner or admin to choose a plan.'
            )}`
      }
      action={action}
      className={className}
    />
  )
}

/** Shown on Cloud workspaces while the team's trial is used up and no plan has started. */
export function OrcaCloudTrialUsedUpBanner(): React.JSX.Element | null {
  const access = useOrcaCloudRunTargetAccess(true)
  if (access.state !== 'no-plan' || !access.trialUsedUp) {
    return null
  }
  return <OrcaCloudTrialUsedUpNotice canManageBilling={access.canManageBilling} />
}
