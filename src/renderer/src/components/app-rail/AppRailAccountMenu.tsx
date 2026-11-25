import React, { useId, useMemo, useState } from 'react'
import { Loader2, LogIn, LogOut, Settings } from 'lucide-react'
import { useAppStore } from '@/store/index'
import { cn } from '@/lib/class-names'
import type { OrcaProfileCloudSummary } from '../../../../shared/orca-profiles/orca-profiles'
import { useTranslate } from '@/i18n/use-translate'
import { useOptionalShortcutLabel } from '@/lib/keyboard/useShortcutLabel'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { SettingsTooltipLabel } from '@/components/sidebar/chrome/SidebarSettingsHelpMenu'
import {
  MilestonesMenuItem,
  type HelpMenuController,
  type SetupMilestones
} from '@/components/sidebar/chrome/help-menu-controller'
import { OrcaProfileSignOutConfirmDialog } from '@/components/orca-profiles/OrcaProfileSignOutConfirmDialog'
import { APP_RAIL_ICON_SIZE, APP_RAIL_ICON_STROKE_WIDTH, AppRailButton } from './AppRailButton'

export type AppRailAccount = { name: string; email: string | undefined; initial: string }

/** How the signed-in account reads on the rail: its name (else email, else `fallbackName`) and that name's initial. */
export function appRailAccount(
  cloud: OrcaProfileCloudSummary | undefined,
  fallbackName: string
): AppRailAccount {
  const email = cloud?.email.trim() || undefined
  const name = cloud?.displayName?.trim() || email || fallbackName
  // Array.from so an initial outside the BMP (an emoji, CJK extension) stays one whole character.
  const initial = (Array.from(name)[0] ?? '?').toLocaleUpperCase()
  return { name, email, initial }
}

function AccountInitial({
  initial,
  className
}: {
  initial: string
  className: string
}): React.JSX.Element {
  return (
    <span
      aria-hidden
      className={cn(
        'flex shrink-0 items-center justify-center rounded-full bg-foreground/15 font-semibold text-foreground',
        className
      )}
    >
      {initial}
    </span>
  )
}

/** Thin done/total arc around the trigger's avatar or gear while core setup is unfinished. */
function SetupRing({ milestones }: { milestones: SetupMilestones }): React.JSX.Element {
  const total = Math.max(milestones.total, 1)
  const done = Math.min(Math.max(milestones.done, 0), total)
  const radius = 12
  const circumference = 2 * Math.PI * radius
  return (
    <svg
      aria-hidden
      viewBox="0 0 26 26"
      className="pointer-events-none absolute inset-0 size-[26px] -rotate-90"
    >
      <circle
        cx="13"
        cy="13"
        r={radius}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        className="opacity-35 dark:opacity-25"
      />
      <circle
        cx="13"
        cy="13"
        r={radius}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeDasharray={circumference}
        strokeDashoffset={circumference * (1 - done / total)}
      />
    </svg>
  )
}

/**
 * The rail's one bottom button: the account avatar (signed in) or the Settings gear (signed out), opening one flat
 * menu with the account, Milestones, Settings, every Help row and Sign in/out. It never folds into More.
 */
export function AppRailAccountMenu({
  help,
  milestones,
  settingsActive,
  onOpenSettings,
  tabStop
}: {
  /** The rail's one Help owner; its dialog is rendered by the rail, not here. */
  help: HelpMenuController
  /** Unfinished core setup (done/total), or null once it's done or unknown. */
  milestones: SetupMilestones | null
  settingsActive: boolean
  onOpenSettings: () => void
  tabStop: boolean
}): React.JSX.Element {
  const t = useTranslate()
  const signedIn = useAppStore((s) => s.orcaProfileAuthStatus?.state === 'connected')
  // A stable store reference, so the rail re-renders only when the auth status changes.
  const cloud = useAppStore((s) => s.orcaProfileAuthStatus?.cloud)
  const fallbackName = t('auto.components.settings.orcaAccount.account', 'Orca account')
  const account = useMemo(
    () => (signedIn ? appRailAccount(cloud, fallbackName) : null),
    [signedIn, cloud, fallbackName]
  )
  const canSignIn = useAppStore((s) => s.orcaProfileAuthStatus?.configured === true)
  const reconnect = useAppStore((s) => s.orcaProfileAuthStatus?.state === 'reconnect-required')
  const signingIn = useAppStore((s) => Boolean(s.orcaProfileSignInProgress))
  const settingsShortcut = useOptionalShortcutLabel('app.settings')
  const setupDescriptionId = useId()
  const [signOutOpen, setSignOutOpen] = useState(false)
  const [signingOut, setSigningOut] = useState(false)

  const settingsLabel = t('auto.components.sidebar.SidebarSettingsHelpMenu.a428c25998', 'Settings')
  const label = account ? t('appRail.account', 'Account') : settingsLabel

  const confirmSignOut = async (): Promise<void> => {
    if (signingOut) {
      return
    }
    setSigningOut(true)
    const result = await useAppStore.getState().signOutCurrentOrcaProfile()
    setSigningOut(false)
    if (result) {
      setSignOutOpen(false)
    }
  }

  const face = account ? (
    <AccountInitial initial={account.initial} className="size-5 text-[10px]" />
  ) : (
    <Settings size={APP_RAIL_ICON_SIZE} strokeWidth={APP_RAIL_ICON_STROKE_WIDTH} aria-hidden />
  )

  return (
    <>
      <DropdownMenu modal={false} onOpenChange={help.handleMenuOpenChange}>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <AppRailButton
                itemId="account"
                label={label}
                // The ring is visual only; screen readers hear the same progress as its description.
                aria-describedby={milestones ? setupDescriptionId : undefined}
                active={settingsActive}
                tabStop={tabStop}
                icon={
                  milestones ? (
                    <span className="relative flex size-[26px] items-center justify-center">
                      {face}
                      <SetupRing milestones={milestones} />
                    </span>
                  ) : (
                    face
                  )
                }
              />
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent side="right" sideOffset={6}>
            <span className="flex max-w-60 items-center gap-1.5">
              {account ? (
                <span className="truncate">{account.name}</span>
              ) : (
                <SettingsTooltipLabel />
              )}
            </span>
          </TooltipContent>
        </Tooltip>
        <DropdownMenuContent side="right" align="end" sideOffset={8} className="w-52">
          {account ? (
            <div className="flex min-w-0 items-center gap-2 px-1.5 py-1.5">
              <AccountInitial initial={account.initial} className="size-5 text-[10px]" />
              <div className="min-w-0">
                <div className="truncate text-[13px] font-medium" title={account.name}>
                  {account.name}
                </div>
                {account.email && account.email !== account.name ? (
                  <div className="truncate text-[11px] text-muted-foreground" title={account.email}>
                    {account.email}
                  </div>
                ) : null}
              </div>
            </div>
          ) : canSignIn ? (
            <DropdownMenuItem
              disabled={signingIn}
              onSelect={() => void useAppStore.getState().connectCurrentOrcaProfile()}
            >
              {signingIn ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <LogIn className="size-3.5" />
              )}
              {signingIn
                ? t('auto.components.OrcaSignInProgress.signingIn', 'Signing in…')
                : reconnect
                  ? t('auto.components.settings.orcaAccount.signInAgain', 'Sign in again')
                  : t('appRail.signIn', 'Sign in')}
            </DropdownMenuItem>
          ) : null}
          {account || canSignIn ? <DropdownMenuSeparator /> : null}
          {milestones ? <MilestonesMenuItem milestones={milestones} progress="badge" /> : null}
          <DropdownMenuItem
            onSelect={onOpenSettings}
            aria-current={settingsActive ? 'page' : undefined}
          >
            <Settings className="size-3.5" />
            {settingsLabel}
            {settingsShortcut ? (
              <DropdownMenuShortcut>{settingsShortcut}</DropdownMenuShortcut>
            ) : null}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          {help.items}
          {account ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => setSignOutOpen(true)}>
                <LogOut className="size-3.5" />
                {t('auto.components.settings.orcaAccount.signOut', 'Sign out')}
              </DropdownMenuItem>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
      {milestones ? (
        <span id={setupDescriptionId} className="sr-only">
          {t(
            'auto.components.setup.guide.SetupGuideProgressRing.dac3a4724a',
            '{{value0}} of {{value1}} setup steps complete',
            { value0: milestones.done, value1: milestones.total }
          )}
        </span>
      ) : null}
      <OrcaProfileSignOutConfirmDialog
        open={signOutOpen}
        onOpenChange={setSignOutOpen}
        onConfirm={() => void confirmSignOut()}
        signingOut={signingOut}
      />
    </>
  )
}
