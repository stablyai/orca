import type { Translate } from '@/i18n/use-translate'
import type { NeedsSetupProjectHostOption } from '@/lib/workspace/creation/project-host-setup-options'
import type { OrcaCloudRunTargetAccess } from './orca-cloud-run-target-access'

// Run on rows are options inside one listbox: their inline actions ("Connect", "Set project
// location", "Sign in", …) are not separate Tab stops (DS-22). Each row's accessible description
// says what Enter does instead, so a screen-reader user hears the action the mouse user sees.

/** A host that can't run yet: Enter connects it, or sets the project location on it. */
export function needsSetupRowHint(
  option: Pick<NeedsSetupProjectHostOption, 'label' | 'connectAction' | 'canSetLocation'>,
  can: { connect: boolean; setLocation: boolean; connecting: boolean },
  t: Translate
): string | undefined {
  if (can.connecting) {
    return undefined
  }
  if (option.connectAction && can.connect) {
    return t(
      'auto.components.new.workspace.RunTargetCombobox.hintConnect',
      '{{host}}, not connected. Press Enter to connect.',
      { host: option.label }
    )
  }
  if (option.canSetLocation && can.setLocation) {
    return t(
      'auto.components.new.workspace.RunTargetCombobox.hintSetLocation',
      '{{host}}, project location not set. Press Enter to set it.',
      { host: option.label }
    )
  }
  return undefined
}

/** Orca Cloud when picking it runs a fix first (sign in, plan, overage, payment). */
export function orcaCloudRowHint(
  access: OrcaCloudRunTargetAccess,
  t: Translate
): string | undefined {
  switch (access.state) {
    case 'signed-out':
      return t(
        'auto.components.new.workspace.RunTargetCombobox.hintSignIn',
        'Orca Cloud, signed out. Press Enter to sign in.'
      )
    case 'no-plan':
      if (!access.canManageBilling) {
        return undefined
      }
      return access.lapsed
        ? t(
            'auto.components.new.workspace.RunTargetCombobox.hintRenew',
            'Orca Cloud, your Team plan ended. Press Enter to renew it.'
          )
        : t(
            'auto.components.new.workspace.RunTargetCombobox.hintChoosePlan',
            'Orca Cloud needs a Team plan. Press Enter to choose one.'
          )
    case 'out-of-hours':
      if (!access.canManageBilling) {
        return undefined
      }
      return access.cause === 'cap'
        ? t(
            'auto.components.new.workspace.RunTargetCombobox.hintRaiseCap',
            'Orca Cloud, spend cap reached. Press Enter to raise it.'
          )
        : t(
            'auto.components.new.workspace.RunTargetCombobox.hintTurnOnOverage',
            'Orca Cloud, sandbox hours used up. Press Enter to turn on overage.'
          )
    case 'payment-issue':
      return access.canManageBilling
        ? t(
            'auto.components.new.workspace.RunTargetCombobox.hintUpdatePayment',
            'Orca Cloud, payment failed. Press Enter to update your payment method.'
          )
        : undefined
    case 'loading':
    case 'unknown':
    case 'entitled':
      return undefined
  }
}
