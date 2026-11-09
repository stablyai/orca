import React from 'react'
import { Cloud } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { buttonVariants } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useTranslate } from '@/i18n/use-translate'
import { RunTargetRow } from './RunTargetComboboxRow'
import {
  getOrcaCloudDetail,
  ORCA_CLOUD_LABEL,
  type EphemeralVmRecipeOption
} from './run-target-options'
import {
  formatOrcaCloudHoursLeft,
  type OrcaCloudRunTargetAccess
} from './orca-cloud-run-target-access'

const META = 'ml-2 shrink-0 self-center text-xs tabular-nums text-muted-foreground'

/**
 * Looks like a button but is plain option content: focus stays in the combobox input, Enter on the
 * row runs the same action, and an option must not contain interactive descendants.
 */
function RowActionButton({
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

function OrcaCloudMeta({
  access,
  onAction
}: {
  access: OrcaCloudRunTargetAccess
  onAction: () => void
}): React.JSX.Element | null {
  const t = useTranslate()
  switch (access.state) {
    case 'entitled':
      return (
        <span className={META}>
          {t(
            'auto.components.new.workspace.RunTargetCombobox.orcaCloudHoursLeft',
            '{{hours}} h left',
            {
              hours: formatOrcaCloudHoursLeft(access.remainingSeconds)
            }
          )}
        </span>
      )
    case 'no-plan':
      return (
        <RowActionButton
          label={
            access.lapsed
              ? t('auto.components.new.workspace.RunTargetCombobox.orcaCloudRenew', 'Renew')
              : t('auto.components.new.workspace.RunTargetCombobox.orcaCloudUpgrade', 'Upgrade')
          }
          onAction={onAction}
        />
      )
    case 'out-of-hours':
      return access.canManageBilling ? (
        <RowActionButton
          label={t(
            'auto.components.new.workspace.RunTargetCombobox.orcaCloudAddHours',
            'Add hours'
          )}
          onAction={onAction}
        />
      ) : (
        <span className={META}>
          {t('auto.components.new.workspace.RunTargetCombobox.orcaCloudNoHours', 'No hours left')}
        </span>
      )
    case 'payment-issue':
      return access.canManageBilling ? (
        <RowActionButton
          label={t(
            'auto.components.new.workspace.RunTargetCombobox.orcaCloudUpdatePayment',
            'Update payment'
          )}
          onAction={onAction}
        />
      ) : (
        <span className={cn(META, 'text-destructive')}>
          {t(
            'auto.components.new.workspace.RunTargetCombobox.orcaCloudPaymentFailed',
            'Payment failed'
          )}
        </span>
      )
    case 'signed-out':
      return (
        <RowActionButton
          label={t(
            'auto.components.new.workspace.RunTargetCombobox.orcaCloudSignInButton',
            'Sign in'
          )}
          onAction={onAction}
        />
      )
    case 'unknown':
      return null
  }
}

/** Orca Cloud as a first-class Run-on target, with its hours or upsell trailing the row. */
export function RunTargetOrcaCloudRow({
  recipe,
  access,
  armed,
  current,
  optionId,
  onArm,
  onSelect,
  onBlockedAction
}: {
  recipe: EphemeralVmRecipeOption | null
  access: OrcaCloudRunTargetAccess
  armed: boolean
  current: boolean
  optionId: string | undefined
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
        access.state === 'no-plan' ? (
          <Badge variant="outline" className="px-1.5 py-0 text-2xs text-muted-foreground">
            {t('auto.components.new.workspace.RunTargetCombobox.orcaCloudTeamBadge', 'Team')}
          </Badge>
        ) : undefined
      }
      detail={
        access.state === 'signed-out'
          ? t(
              'auto.components.new.workspace.RunTargetCombobox.orcaCloudSignIn',
              'Sign in to use Orca Cloud'
            )
          : getOrcaCloudDetail(t)
      }
      wrapDetail
      armed={armed}
      current={current}
      optionId={optionId}
      onArm={onArm}
      onCommit={onSelect}
      trailing={<OrcaCloudMeta access={access} onAction={onBlockedAction} />}
    />
  )
}
