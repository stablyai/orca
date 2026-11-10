import React from 'react'
import { cn } from '@/lib/utils'
import { useTranslate } from '@/i18n/use-translate'
import { getOrcaCloudPick, type OrcaCloudRunTargetAccess } from './orca-cloud-run-target-access'
import { invalidateOrcaCloudBilling } from './orca-cloud-billing-cache'
import { openPlansPage } from '@/components/billing/plans/plans-page-store'
import { ORCA_CLOUD_IDLE_SLEEP_MINUTES } from '../../../../shared/hosted-sandbox/hosted-sandbox-wire'
import { OrcaCloudSpecs, useOrcaCloudHoursLeft } from './RunTargetOrcaCloudRow'
import { isOrcaCloudTrialLow } from './run-on/orca-cloud-hours-copy'

/** T1: "Trial · 0.3 sandbox hours left · Choose plan", or who can choose one for members. */
function TrialLowLine({
  access,
  hoursLeft
}: {
  access: OrcaCloudRunTargetAccess
  hoursLeft: string | null
}): React.JSX.Element {
  const t = useTranslate()
  const canChoose = access.state === 'entitled' && access.canManageBilling === true
  return (
    <>
      <p className="flex min-w-0 items-center gap-1.5 font-medium text-status-warning-text">
        <span className="truncate">{hoursLeft}</span>
        {canChoose ? (
          <>
            <span aria-hidden>·</span>
            <button
              type="button"
              className="shrink-0 font-medium text-foreground underline underline-offset-2 hover:no-underline"
              onClick={() => {
                invalidateOrcaCloudBilling({ refetchNow: false })
                openPlansPage('sandbox')
              }}
            >
              {t('components.newWorkspace.cloudSetup.choosePlan', 'Choose plan')}
            </button>
          </>
        ) : null}
      </p>
      <p className="truncate">
        {canChoose
          ? t(
              'auto.components.new.workspace.RunTargetCombobox.orcaCloudIdleSleep',
              'Sleeps after {{count}} minutes idle',
              {
                count: ORCA_CLOUD_IDLE_SLEEP_MINUTES,
                defaultValue_one: 'Sleeps after {{count}} minute idle'
              }
            )
          : t(
              'components.newWorkspace.cloudSetup.askChoosePlan',
              'Ask an owner or admin to choose a plan.'
            )}
      </p>
    </>
  )
}

type BlockCopy = {
  title: string
  detail: string
  tone: 'error' | 'neutral'
  /** Owners/admins only; members read who can fix it in `detail`. */
  action?: string
}

function useBlockCopy(access: OrcaCloudRunTargetAccess): BlockCopy | null {
  const t = useTranslate()
  switch (access.state) {
    case 'no-plan':
      if (access.trialOfferSeconds) {
        // B1: the trial is included; Start claims it, so nothing blocks.
        return null
      }
      if (access.trialUsedUp) {
        // T2: neutral, nothing failed.
        return {
          title: t('components.newWorkspace.cloudSetup.trialUsedUpTitle', 'Your trial is used up'),
          detail: access.canManageBilling
            ? t(
                'components.newWorkspace.cloudSetup.trialUsedUpChoose',
                'Choose a plan to keep using Orca Cloud.'
              )
            : t(
                'components.newWorkspace.cloudSetup.askChoosePlan',
                'Ask an owner or admin to choose a plan.'
              ),
          tone: 'neutral',
          ...(access.canManageBilling
            ? { action: t('components.newWorkspace.cloudSetup.choosePlan', 'Choose plan') }
            : {})
        }
      }
      return {
        title: access.lapsed
          ? t(
              'auto.components.new.workspace.RunTargetCombobox.orcaCloudPlanEnded',
              'Your Team plan ended'
            )
          : t(
              'auto.components.new.workspace.RunTargetCombobox.orcaCloudNeedsTeamPlan',
              'Orca Cloud needs a Team plan.'
            ),
        detail: access.canManageBilling
          ? ''
          : t(
              'auto.components.new.workspace.RunTargetCombobox.orcaCloudAskChoosePlan',
              'Ask an owner or admin to choose one.'
            ),
        tone: 'neutral',
        ...(access.canManageBilling
          ? {
              action: access.lapsed
                ? t('auto.components.new.workspace.RunTargetCombobox.orcaCloudRenew', 'Renew')
                : t('auto.components.new.workspace.RunTargetCombobox.orcaCloudUpgrade', 'Upgrade')
            }
          : {})
      }
    case 'out-of-hours': {
      const cap = access.cause === 'cap'
      // Create time: no workspace exists yet, so "Your files are safe." does not apply here.
      return {
        title: cap
          ? t(
              'auto.components.new.workspace.RunTargetCombobox.orcaCloudCapReached',
              'Spend cap reached'
            )
          : t(
              'auto.components.new.workspace.RunTargetCombobox.orcaCloudOutOfHours',
              'Out of sandbox hours'
            ),
        detail: access.canManageBilling
          ? ''
          : cap
            ? t(
                'auto.components.new.workspace.RunTargetCombobox.orcaCloudAskRaiseSpendCap',
                'Ask an owner or admin to raise the spend cap.'
              )
            : t(
                'auto.components.new.workspace.RunTargetCombobox.orcaCloudAskAddHoursOnly',
                'Ask an owner or admin to add hours.'
              ),
        tone: 'neutral',
        ...(access.canManageBilling
          ? {
              action:
                access.cause === 'cap'
                  ? t(
                      'auto.components.new.workspace.RunTargetCombobox.orcaCloudRaiseSpendCap',
                      'Raise spend cap'
                    )
                  : t(
                      'auto.components.new.workspace.RunTargetCombobox.orcaCloudTurnOnOverage',
                      'Turn on overage'
                    )
            }
          : {})
      }
    }
    case 'payment-issue':
      return {
        title: t(
          'auto.components.new.workspace.RunTargetCombobox.orcaCloudPaymentFailed',
          'Payment failed'
        ),
        detail: access.canManageBilling
          ? t(
              'auto.components.new.workspace.RunTargetCombobox.orcaCloudPaymentEffect',
              "New sandboxes can't start."
            )
          : t(
              'auto.components.new.workspace.RunTargetCombobox.orcaCloudAskPayment',
              'Ask an owner or admin to update the payment method.'
            ),
        tone: 'error',
        ...(access.canManageBilling
          ? {
              action: t(
                'auto.components.new.workspace.RunTargetCombobox.orcaCloudUpdatePaymentMethod',
                'Update payment method'
              )
            }
          : {})
      }
    case 'loading':
    case 'unknown':
    case 'signed-out':
    case 'entitled':
      return null
  }
}

/**
 * Context under Run on once Orca Cloud is the committed target, in exactly two reserved lines so
 * neither picking nor a late billing answer moves the form: specs and sandbox hours over idle
 * sleep, or what blocks it over who can fix it, with the fix as an inline link. The wrapper is an
 * always-mounted polite live region, so a block that arrives after the pick is announced.
 */
export function OrcaCloudSelectionHint({
  access,
  visible
}: {
  access: OrcaCloudRunTargetAccess
  /** Orca Cloud is the committed target; otherwise the two lines stay empty. */
  visible: boolean
}): React.JSX.Element {
  const t = useTranslate()
  const block = useBlockCopy(access)
  const hoursLeft = useOrcaCloudHoursLeft(access)
  // T1: under half an hour of trial left, announced once as it crosses (the live region below).
  const low = isOrcaCloudTrialLow(access)
  const pick = getOrcaCloudPick(access)
  const action =
    block?.action && pick.kind === 'act' ? (
      <button
        type="button"
        className="shrink-0 font-medium text-foreground underline underline-offset-2 hover:no-underline"
        onClick={() => {
          // The fix finishes elsewhere; reread billing when the user comes back.
          invalidateOrcaCloudBilling({ refetchNow: false })
          pick.run()
        }}
      >
        {block.action}
      </button>
    ) : null
  return (
    // @container: the specs drop out whole when the column is narrow, instead of ellipsizing.
    <div className="@container h-8 text-2xs leading-4 tabular-nums text-muted-foreground">
      {visible && !block && !low ? (
        // Outside the live region: hour ticks on refresh are not re-announced.
        <>
          <p className="flex min-w-0">
            <span className="truncate">
              <OrcaCloudSpecs t={t} />
            </span>
            {hoursLeft ? (
              // pl-1: a flex item trims its leading space, so the gap before "·" comes from padding.
              <span className="shrink-0 whitespace-nowrap pl-1">
                {'· '}
                {hoursLeft}
              </span>
            ) : null}
          </p>
          <p className="truncate">
            {/* One source for n: the control plane, billing and every surface read this constant. */}
            {t(
              'auto.components.new.workspace.RunTargetCombobox.orcaCloudIdleSleep',
              'Sleeps after {{count}} minutes idle',
              {
                count: ORCA_CLOUD_IDLE_SLEEP_MINUTES,
                defaultValue_one: 'Sleeps after {{count}} minute idle'
              }
            )}
          </p>
        </>
      ) : null}
      {/* Always mounted, so a block that arrives after the pick (late billing, restored draft) is announced. */}
      <div aria-live="polite">
        {visible && !block && low ? <TrialLowLine access={access} hoursLeft={hoursLeft} /> : null}
        {visible && block ? (
          <>
            <p
              className={cn(
                'flex min-w-0 items-center gap-1.5 font-medium',
                block.tone === 'error' ? 'text-foreground' : 'text-status-warning-text'
              )}
            >
              {block.tone === 'error' ? (
                <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-destructive" />
              ) : null}
              <span className="truncate">{block.title}</span>
              {action ? <span aria-hidden>·</span> : null}
              {action}
            </p>
            {block.detail ? <p className="truncate">{block.detail}</p> : null}
          </>
        ) : null}
      </div>
    </div>
  )
}
