import React from 'react'
import { orcaCloudRowHint } from './run-target-row-hints'
import { Cloud } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { buttonVariants } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'
import { useIntlLocale, useTranslate } from '@/i18n/use-translate'
import type { Translate } from '@/i18n/use-translate'
import { RunTargetRow } from './RunTargetComboboxRow'
import { ORCA_CLOUD_LABEL, type EphemeralVmRecipeOption } from './run-target-options'
import {
  getOrcaCloudHoursLeft,
  type OrcaCloudRunTargetAccess
} from './orca-cloud-run-target-access'
import { ORCA_CLOUD_SANDBOX_SPEC } from '../../../../shared/hosted-sandbox/hosted-sandbox-wire'

/**
 * Looks like a button but is plain option content: focus stays in the combobox input, Enter on the
 * row runs the same action, and an option must not contain interactive descendants.
 */
function RowAction({
  label,
  onAction,
  alignTop = false
}: {
  label: string
  onAction: () => void
  /** Beside a wrapping reason, the action sits at the top of the row. */
  alignTop?: boolean
}): React.JSX.Element {
  return (
    <span
      className={cn(
        buttonVariants({ variant: 'outline', size: 'xs' }),
        'ml-2 shrink-0',
        alignTop ? 'self-start' : 'self-center'
      )}
      onMouseDown={(event) => {
        event.preventDefault()
        event.stopPropagation()
      }}
      onClick={(event) => {
        event.preventDefault()
        event.stopPropagation()
        onAction()
      }}
    >
      {label}
    </span>
  )
}

/**
 * "Sandbox · 8 vCPU · 16 GB" in the Run on menu row. The specs never split: below a 28rem
 * container they drop out whole rather than wrap.
 */
export function OrcaCloudSpecs({ t }: { t: Translate }): React.JSX.Element {
  return (
    <>
      {t('auto.components.new.workspace.RunTargetCombobox.orcaCloudHosted', 'Sandbox')}
      <span className="hidden whitespace-nowrap @[28rem]:inline">
        {' · '}
        {t(
          'auto.components.new.workspace.RunTargetCombobox.orcaCloudSpecs2',
          '{{value0}} vCPU · {{value1}} GB',
          {
            value0: String(ORCA_CLOUD_SANDBOX_SPEC.vcpus),
            value1: String(ORCA_CLOUD_SANDBOX_SPEC.memoryGb)
          }
        )}
      </span>
    </>
  )
}

/**
 * Whether the Run on menu's Orca Cloud row shows "N sandbox hours left". Off for now (Neil, JA-25
 * follow-up): the row reads "Orca Cloud" / "Sandbox"; hours live on Account + Billing and the plan
 * blocker. Flip to true to bring them back, along with the loading placeholder that holds their place.
 */
export const RUN_ON_SHOWS_HOURS_LEFT = false

/** "41 sandbox hours left" (locale number, plural-aware), or null when not entitled. */
export function useOrcaCloudHoursLeft(access: OrcaCloudRunTargetAccess): string | null {
  const t = useTranslate()
  const locale = useIntlLocale()
  if (access.state === 'no-plan' && access.trialOfferSeconds) {
    // B1: the team's trial, not started yet.
    const offered = getOrcaCloudHoursLeft(access.trialOfferSeconds)
    return t(
      'components.newWorkspace.cloudHours.trialOffered',
      'Trial · {{hours}} sandbox hours left · No card needed',
      {
        count: offered,
        hours: new Intl.NumberFormat(locale, {
          maximumFractionDigits: 1
        }).format(offered),
        defaultValue_one: 'Trial · {{hours}} sandbox hour left · No card needed'
      }
    )
  }
  if (access.state !== 'entitled') {
    return null
  }
  const count = getOrcaCloudHoursLeft(access.remainingSeconds)
  if (access.trial) {
    // T1: trial hours are a one-time allowance, so the line says whose hours these are.
    return t(
      'components.newWorkspace.cloudHours.trialChip',
      'Trial · {{hours}} sandbox hours left',
      {
        count,
        hours: new Intl.NumberFormat(locale, {
          maximumFractionDigits: 1
        }).format(count),
        defaultValue_one: 'Trial · {{hours}} sandbox hour left'
      }
    )
  }
  return t(
    'auto.components.new.workspace.RunTargetCombobox.orcaCloudSandboxHoursLeft',
    '{{hours}} sandbox hours left',
    {
      count,
      hours: new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(count),
      defaultValue_one: '{{hours}} sandbox hour left'
    }
  )
}

/** The second line: specs when usable, otherwise what blocks it. */
function OrcaCloudDetail({ access }: { access: OrcaCloudRunTargetAccess }): React.JSX.Element {
  const t = useTranslate()
  switch (access.state) {
    case 'signed-out':
      return (
        <>
          {t(
            'auto.components.new.workspace.RunTargetCombobox.orcaCloudSignInDetail',
            'Sign in to start a sandbox'
          )}
        </>
      )
    case 'no-plan':
      return access.lapsed ? (
        <>
          {t(
            'auto.components.new.workspace.RunTargetCombobox.orcaCloudPlanEnded',
            'Your Team plan ended'
          )}
        </>
      ) : (
        <OrcaCloudSpecs t={t} />
      )
    case 'out-of-hours':
      return access.cause === 'cap' ? (
        <>
          {t(
            'auto.components.new.workspace.RunTargetCombobox.orcaCloudCapReached',
            'Spend cap reached'
          )}
        </>
      ) : (
        <>
          {t(
            'auto.components.new.workspace.RunTargetCombobox.orcaCloudOutOfHours',
            'Out of sandbox hours'
          )}
        </>
      )
    case 'payment-issue':
      return (
        <span className="text-foreground">
          <span
            aria-hidden
            className="mr-1.5 inline-block size-1.5 rounded-full bg-destructive align-middle"
          />
          {t(
            'auto.components.new.workspace.RunTargetCombobox.orcaCloudPaymentFailed',
            'Payment failed'
          )}
        </span>
      )
    case 'loading':
    case 'unknown':
    case 'entitled':
      return <OrcaCloudSpecs t={t} />
  }
}

/** Members can't fix billing; say who can rather than offer a pick that does nothing. */
function AskOwnerOrAdmin(): React.JSX.Element {
  const t = useTranslate()
  return (
    <span className="ml-2 shrink-0 self-center text-xs text-muted-foreground">
      {t(
        'auto.components.new.workspace.RunTargetCombobox.orcaCloudAskOwnerOrAdmin',
        'Ask an owner or admin'
      )}
    </span>
  )
}

function OrcaCloudMeta({
  access,
  onAction,
  alignTop = false
}: {
  access: OrcaCloudRunTargetAccess
  onAction: () => void
  alignTop?: boolean
}): React.JSX.Element | null {
  const t = useTranslate()
  const hoursLeft = useOrcaCloudHoursLeft(access)
  switch (access.state) {
    case 'loading': {
      const checking = (
        <span className="sr-only">
          {t(
            'auto.components.new.workspace.RunTargetCombobox.orcaCloudChecking',
            'Checking your plan…'
          )}
        </span>
      )
      // The placeholder only holds the hours' place; without hours it would just flash.
      return RUN_ON_SHOWS_HOURS_LEFT ? (
        <span className="ml-2 flex shrink-0 self-center">
          <Skeleton className="h-3 w-12" />
          {checking}
        </span>
      ) : (
        checking
      )
    }
    case 'entitled':
      return RUN_ON_SHOWS_HOURS_LEFT ? (
        <span className="ml-2 shrink-0 self-center text-xs tabular-nums text-muted-foreground">
          {hoursLeft}
        </span>
      ) : null
    case 'signed-out':
      return (
        <RowAction
          label={t(
            'auto.components.new.workspace.RunTargetCombobox.orcaCloudSignInButton',
            'Sign in'
          )}
          onAction={onAction}
          alignTop={alignTop}
        />
      )
    case 'no-plan':
      if (!access.canManageBilling) {
        return <AskOwnerOrAdmin />
      }
      return (
        <RowAction
          label={
            access.lapsed
              ? t('auto.components.new.workspace.RunTargetCombobox.orcaCloudRenew', 'Renew')
              : t('auto.components.new.workspace.RunTargetCombobox.orcaCloudUpgrade', 'Upgrade')
          }
          onAction={onAction}
          alignTop={alignTop}
        />
      )
    case 'out-of-hours':
    case 'payment-issue':
      if (!access.canManageBilling) {
        return <AskOwnerOrAdmin />
      }
      return (
        <RowAction
          label={
            access.state === 'payment-issue'
              ? t(
                  'auto.components.new.workspace.RunTargetCombobox.orcaCloudUpdatePaymentMethod',
                  'Update payment method'
                )
              : access.cause === 'cap'
                ? t(
                    'auto.components.new.workspace.RunTargetCombobox.orcaCloudRaiseSpendCap',
                    'Raise spend cap'
                  )
                : t(
                    'auto.components.new.workspace.RunTargetCombobox.orcaCloudTurnOnOverage',
                    'Turn on overage'
                  )
          }
          onAction={onAction}
          alignTop={alignTop}
        />
      )
    case 'unknown':
      return null
  }
}

/** Orca Cloud as a first-class Run-on target, with the fix for what blocks it (and hours, behind RUN_ON_SHOWS_HOURS_LEFT). */
export function RunTargetOrcaCloudRow({
  recipe,
  access,
  pending,
  armed,
  current,
  optionId,
  onArm,
  onSelect,
  onBlockedAction,
  setupAfterStart = false
}: {
  recipe: EphemeralVmRecipeOption | null
  access: OrcaCloudRunTargetAccess
  /** A pick is waiting on the first billing answer. */
  pending: boolean
  armed: boolean
  current: boolean
  optionId: string
  onArm: () => void
  onSelect: () => void
  onBlockedAction: () => void
  /** The composer walks setup on a page after Start: no inline Sign in / Upgrade here. */
  setupAfterStart?: boolean
}): React.JSX.Element {
  const t = useTranslate()
  // JA-21 (Neil): the composer says nothing about plan, hours or payment; Create checks and the
  // creating sheet shows any blocker. Outside the composer the row still names the fix.
  const shown: OrcaCloudRunTargetAccess =
    setupAfterStart &&
    (access.state === 'no-plan' ||
      access.state === 'out-of-hours' ||
      access.state === 'payment-issue')
      ? { state: 'unknown' }
      : access
  return (
    <RunTargetRow
      icon={<Cloud className="size-3.5 shrink-0 text-muted-foreground" />}
      label={recipe?.name ?? ORCA_CLOUD_LABEL}
      labelBadge={
        shown.state === 'no-plan' && !shown.lapsed ? (
          <Badge variant="tag">
            {t('auto.components.new.workspace.RunTargetCombobox.orcaCloudTeamBadge', 'Team')}
          </Badge>
        ) : undefined
      }
      detail=""
      detailNode={<OrcaCloudDetail access={shown} />}
      armed={armed}
      current={current}
      disabled={
        (shown.state === 'no-plan' ||
          shown.state === 'out-of-hours' ||
          shown.state === 'payment-issue') &&
        !shown.canManageBilling
      }
      optionId={optionId}
      busy={pending}
      onArm={onArm}
      onCommit={onSelect}
      description={orcaCloudRowHint(shown, t)}
      trailing={
        // The composer walks sign-in on its setup page after Start: no inline meta here.
        setupAfterStart ? undefined : <OrcaCloudMeta access={shown} onAction={onBlockedAction} />
      }
    />
  )
}
