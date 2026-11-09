import React from 'react'
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

/**
 * Looks like a button but is plain option content: focus stays in the combobox input, Enter on the
 * row runs the same action, and an option must not contain interactive descendants.
 */
function RowAction({
  label,
  onAction
}: {
  label: string
  onAction: () => void
}): React.JSX.Element {
  return (
    <span
      className={cn(
        buttonVariants({ variant: 'outline', size: 'xs' }),
        'ml-2 shrink-0 self-center'
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
 * "Hosted sandbox · 4 vCPU · 8 GB". The specs never split: below a 28rem container (the menu, or
 * the hint under the field) they drop out whole so "N sandbox hours left" keeps its room.
 */
export function OrcaCloudSpecs({ t }: { t: Translate }): React.JSX.Element {
  return (
    <>
      {t('auto.components.new.workspace.RunTargetCombobox.orcaCloudHosted', 'Hosted sandbox')}
      <span className="hidden whitespace-nowrap @[28rem]:inline">
        {' · '}
        {t('auto.components.new.workspace.RunTargetCombobox.orcaCloudSpecs', '4 vCPU · 8 GB')}
      </span>
    </>
  )
}

/** "41 sandbox hours left" (locale number, plural-aware), or null when not entitled. */
export function useOrcaCloudHoursLeft(access: OrcaCloudRunTargetAccess): string | null {
  const t = useTranslate()
  const locale = useIntlLocale()
  if (access.state !== 'entitled') {
    return null
  }
  const count = getOrcaCloudHoursLeft(access.remainingSeconds)
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

function OrcaCloudMeta({
  access,
  onAction
}: {
  access: OrcaCloudRunTargetAccess
  onAction: () => void
}): React.JSX.Element | null {
  const t = useTranslate()
  const hoursLeft = useOrcaCloudHoursLeft(access)
  switch (access.state) {
    case 'loading':
      return (
        <span className="ml-2 flex shrink-0 self-center">
          <Skeleton className="h-3 w-12" />
          <span className="sr-only">
            {t(
              'auto.components.new.workspace.RunTargetCombobox.orcaCloudChecking',
              'Checking your plan…'
            )}
          </span>
        </span>
      )
    case 'entitled':
      return (
        <span className="ml-2 shrink-0 self-center text-xs tabular-nums text-muted-foreground">
          {hoursLeft}
        </span>
      )
    case 'signed-out':
      return (
        <RowAction
          label={t(
            'auto.components.new.workspace.RunTargetCombobox.orcaCloudSignInButton',
            'Sign in'
          )}
          onAction={onAction}
        />
      )
    case 'no-plan':
      return (
        <RowAction
          label={
            access.lapsed
              ? t('auto.components.new.workspace.RunTargetCombobox.orcaCloudRenew', 'Renew')
              : t('auto.components.new.workspace.RunTargetCombobox.orcaCloudUpgrade', 'Upgrade')
          }
          onAction={onAction}
        />
      )
    case 'out-of-hours':
    case 'payment-issue':
      if (!access.canManageBilling) {
        // Members can't fix it; say who can rather than offer a pick that does nothing.
        return (
          <span className="ml-2 shrink-0 self-center text-xs text-muted-foreground">
            {t(
              'auto.components.new.workspace.RunTargetCombobox.orcaCloudAskOwnerOrAdmin',
              'Ask an owner or admin'
            )}
          </span>
        )
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
        />
      )
    case 'unknown':
      return null
  }
}

/** Orca Cloud as a first-class Run-on target, with its hours or the fix for what blocks it. */
export function RunTargetOrcaCloudRow({
  recipe,
  access,
  pending,
  armed,
  current,
  optionId,
  onArm,
  onSelect,
  onBlockedAction
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
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <RunTargetRow
      icon={<Cloud className="size-3.5 shrink-0 text-muted-foreground" />}
      label={recipe?.name ?? ORCA_CLOUD_LABEL}
      labelBadge={
        access.state === 'no-plan' && !access.lapsed ? (
          <Badge variant="tag">
            {t('auto.components.new.workspace.RunTargetCombobox.orcaCloudTeamBadge', 'Team')}
          </Badge>
        ) : undefined
      }
      detail=""
      detailNode={<OrcaCloudDetail access={access} />}
      armed={armed}
      current={current}
      disabled={
        (access.state === 'out-of-hours' || access.state === 'payment-issue') &&
        !access.canManageBilling
      }
      optionId={optionId}
      busy={pending}
      onArm={onArm}
      onCommit={onSelect}
      trailing={<OrcaCloudMeta access={access} onAction={onBlockedAction} />}
    />
  )
}
