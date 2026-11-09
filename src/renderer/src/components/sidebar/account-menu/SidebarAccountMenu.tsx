import React, { useState } from 'react'
import { Settings, UserRound } from 'lucide-react'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { useMountedRef } from '@/hooks/useMountedRef'
import { useOptionalShortcutLabel } from '@/hooks/useShortcutLabel'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/utils'
import { useSetupGuideProgress } from '../../setup-guide/use-setup-guide-progress'
import { getAccountMenuIdentity, type AccountMenuIdentity } from './account-menu-identity'
import { selectVisibleAccountMenuItems, useRegisteredAccountMenuItems } from './account-menu-items'
import {
  loadSidebarFeedbackDialog,
  SidebarFeedbackDialog,
  SidebarHelpSubmenu
} from './SidebarHelpSubmenu'

function AccountAvatar({
  identity,
  className
}: {
  identity: AccountMenuIdentity
  className?: string
}): React.JSX.Element {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'flex shrink-0 items-center justify-center rounded-full font-medium',
        identity.signedIn
          ? 'bg-foreground/85 text-background'
          : 'border border-border bg-muted text-muted-foreground',
        className
      )}
    >
      {identity.signedIn ? identity.initial : <UserRound className="size-[62%]" />}
    </span>
  )
}

export function SidebarAccountMenu(): React.JSX.Element {
  const t = useTranslate()
  const authStatus = useAppStore((s) => s.orcaProfileAuthStatus)
  const signingIn = useAppStore((s) => Boolean(s.orcaProfileSignInProgress))
  const connectCurrentOrcaProfile = useAppStore((s) => s.connectCurrentOrcaProfile)
  const openSettingsPage = useAppStore((s) => s.openSettingsPage)
  const openSettingsTarget = useAppStore((s) => s.openSettingsTarget)
  const setupProgress = useSetupGuideProgress(true, false, false)
  const settingsShortcut = useOptionalShortcutLabel('app.settings')
  const registeredItems = useRegisteredAccountMenuItems()
  const [menuOpen, setMenuOpen] = useState(false)
  const [feedbackOpen, setFeedbackOpen] = useState(false)
  // Retain the mounted dialog through its closing animation.
  const [feedbackDialogMounted, setFeedbackDialogMounted] = useState(false)
  const [isRestartingOrca, setIsRestartingOrca] = useState(false)
  const mountedRef = useMountedRef()

  const identity = getAccountMenuIdentity(authStatus)
  const extensionItems = selectVisibleAccountMenuItems(registeredItems, authStatus)
  const milestones =
    setupProgress.ready && setupProgress.coreDoneCount < setupProgress.coreTotal
      ? { done: setupProgress.coreDoneCount, total: setupProgress.coreTotal }
      : null
  const accountLabel = t('auto.components.sidebar.SidebarAccountMenu.account', 'Account')

  const handleMenuOpenChange = (open: boolean): void => {
    setMenuOpen(open)
    if (open) {
      // Warm while users read the menu so feedback is loaded before selection.
      void loadSidebarFeedbackDialog().catch(() => {})
    }
  }

  const openAccountSettings = (): void => {
    openSettingsTarget({ pane: 'orca-account', repoId: null })
    openSettingsPage()
  }

  // Builds without Orca sign-in (and the unloaded state) have no account to show or connect.
  const showAccountHeader = identity.signedIn || authStatus?.configured === true

  const handleAccountHeaderSelect = (): void => {
    // The account pane hosts sign-out and the pending sign-in link.
    if (identity.signedIn || signingIn) {
      openAccountSettings()
      return
    }
    void connectCurrentOrcaProfile()
  }

  const handleOpenFeedback = (): void => {
    setFeedbackDialogMounted(true)
    setFeedbackOpen(true)
  }

  const handleRestartOrca = (): void => {
    if (isRestartingOrca) {
      return
    }
    setIsRestartingOrca(true)
    toast.info(t('auto.components.sidebar.SidebarSettingsHelpMenu.5161eef55d', 'Restarting Orca…'))
    void window.api.app.restart().catch((error) => {
      if (mountedRef.current) {
        setIsRestartingOrca(false)
        toast.error(
          t('auto.components.sidebar.SidebarSettingsHelpMenu.4e8f5710d3', "Couldn't restart Orca."),
          {
            description: error instanceof Error ? error.message : undefined
          }
        )
      }
    })
  }

  return (
    <>
      <DropdownMenu modal={false} open={menuOpen} onOpenChange={handleMenuOpenChange}>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon-xs"
                type="button"
                aria-label={accountLabel}
                data-account-menu-trigger=""
                className="text-muted-foreground"
              >
                <AccountAvatar identity={identity} className="size-[18px] text-[10px]" />
              </Button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent side="top" sideOffset={4}>
            {identity.signedIn ? identity.name : accountLabel}
          </TooltipContent>
        </Tooltip>
        <DropdownMenuContent side="top" align="start" sideOffset={8} className="w-60">
          {showAccountHeader ? (
            <>
              <DropdownMenuItem onSelect={handleAccountHeaderSelect} data-account-menu-header="">
                <AccountAvatar identity={identity} className="size-7 text-xs" />
                <span className="flex min-w-0 flex-col">
                  {identity.signedIn ? (
                    <>
                      <span className="truncate font-medium">{identity.name}</span>
                      {identity.name !== identity.email ? (
                        <span className="truncate text-xs text-muted-foreground">
                          {identity.email}
                        </span>
                      ) : null}
                    </>
                  ) : (
                    <>
                      <span className="truncate font-medium">
                        {identity.needsReconnect
                          ? t('auto.components.settings.orcaAccount.signInAgain', 'Sign in again')
                          : t('auto.components.sidebar.SidebarAccountMenu.signIn', 'Sign in')}
                      </span>
                      <span className="truncate text-xs text-muted-foreground">
                        {signingIn
                          ? t('auto.components.OrcaSignInProgress.signingIn', 'Signing in…')
                          : t('auto.components.settings.orcaAccount.account', 'Orca account')}
                      </span>
                    </>
                  )}
                </span>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
            </>
          ) : null}
          {extensionItems.length > 0 ? (
            <>
              {extensionItems.map((item) => {
                const Icon = item.icon
                return (
                  <DropdownMenuItem
                    key={item.id}
                    data-account-menu-item={item.id}
                    data-tone={item.tone}
                    onSelect={item.onSelect}
                    className={cn(item.tone === 'accent' && 'font-medium text-foreground')}
                  >
                    {Icon ? (
                      <Icon
                        className={cn('size-3.5', item.tone === 'accent' && 'text-foreground')}
                      />
                    ) : null}
                    {item.label()}
                  </DropdownMenuItem>
                )
              })}
              <DropdownMenuSeparator />
            </>
          ) : null}
          <DropdownMenuItem onSelect={openSettingsPage}>
            <Settings className="size-3.5" />
            {t('auto.components.sidebar.SidebarSettingsHelpMenu.a428c25998', 'Settings')}
            {settingsShortcut ? (
              <DropdownMenuShortcut>{settingsShortcut}</DropdownMenuShortcut>
            ) : null}
          </DropdownMenuItem>
          <SidebarHelpSubmenu
            milestones={milestones}
            onOpenFeedback={handleOpenFeedback}
            restartPending={isRestartingOrca}
            onRestart={handleRestartOrca}
          />
        </DropdownMenuContent>
      </DropdownMenu>
      {feedbackDialogMounted ? (
        <React.Suspense fallback={null}>
          <SidebarFeedbackDialog open={feedbackOpen} onOpenChange={setFeedbackOpen} />
        </React.Suspense>
      ) : null}
    </>
  )
}
