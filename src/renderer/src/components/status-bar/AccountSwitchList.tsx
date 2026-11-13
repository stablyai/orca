import { UserPlus } from 'lucide-react'
import React from 'react'
import {
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator
} from '@/components/ui/dropdown-menu'
import { useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '../../store'
import { normalizeUsagePercentageDisplay } from '../../../../shared/usage-percentage-display'

export function AccountSwitchList({
  heading,
  children
}: {
  heading: string
  children: React.ReactNode
}): React.JSX.Element {
  const t = useTranslate()
  const display = normalizeUsagePercentageDisplay(
    useAppStore((state) => state.usagePercentageDisplay)
  )
  return (
    <div className="pb-1">
      <DropdownMenuLabel>
        <span className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate">{heading}</span>
          <span className="flex shrink-0 items-end gap-1 text-right">
            <span className="min-w-8 whitespace-nowrap">
              {display === 'used'
                ? t('auto.components.status.bar.AccountSwitchList.used', 'Used')
                : t('auto.components.status.bar.AccountSwitchList.left', 'Left')}
            </span>
            <span className="w-11 shrink-0 whitespace-normal break-all">
              {t('auto.components.status.bar.AccountSwitchList.reset', 'Reset')}
            </span>
          </span>
        </span>
      </DropdownMenuLabel>
      <div className="max-h-[min(300px,40vh)] overflow-y-auto scrollbar-sleek">{children}</div>
    </div>
  )
}

/** Groups accounts that need a sign-in below the usable ones. */
export function AccountSwitchSignedOutHeading(): React.JSX.Element {
  const t = useTranslate()
  return (
    <DropdownMenuLabel className="mt-1">
      {t('auto.components.status.bar.StatusBar.signedOutAccounts', 'Signed out')}
    </DropdownMenuLabel>
  )
}

/**
 * Account list plus a settings link. When the only row is the active account the panel already
 * names, the list is a duplicate, so it becomes a prompt to add another instead.
 */
export function AccountSwitchSection({
  heading,
  targets,
  panelShowsActiveAccount,
  onOpenSettings,
  children
}: {
  heading: string
  targets: readonly { active: boolean }[]
  panelShowsActiveAccount: boolean
  onOpenSettings: () => void
  children: React.ReactNode
}): React.JSX.Element {
  const t = useTranslate()
  if (panelShowsActiveAccount && targets.length === 1 && targets[0].active) {
    return (
      <>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onOpenSettings}>
          <UserPlus className="size-3.5" />
          {t('auto.components.status.bar.StatusBar.addAnotherAccount', 'Add another account…')}
        </DropdownMenuItem>
      </>
    )
  }
  return (
    <>
      <AccountSwitchList heading={heading}>{children}</AccountSwitchList>
      <DropdownMenuSeparator />
      <DropdownMenuItem onSelect={onOpenSettings}>
        {t('auto.components.status.bar.StatusBar.75ded02687', 'Manage Accounts…')}
      </DropdownMenuItem>
    </>
  )
}
