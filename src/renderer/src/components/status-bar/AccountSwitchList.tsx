import { UserPlus } from 'lucide-react'
import React from 'react'
import {
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator
} from '@/components/ui/dropdown-menu'
import { useTranslate } from '@/i18n/use-translate'

export function AccountSwitchList({
  heading,
  children
}: {
  heading: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="pb-1">
      <DropdownMenuLabel>{heading}</DropdownMenuLabel>
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
