import React, { useId, useMemo, useRef, useState } from 'react'
import { Settings } from 'lucide-react'
import { useAppStore } from '@/store/index'
import { cn } from '@/lib/class-names'
import type { OrcaProfileCloudSummary } from '../../../../shared/orca-profiles/orca-profiles'
import { useTranslate } from '@/i18n/use-translate'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { DropdownMenu, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { SettingsTooltipLabel } from '@/components/sidebar/chrome/SidebarSettingsHelpMenu'
import type {
  HelpMenuController,
  SetupMilestones
} from '@/components/sidebar/chrome/help-menu-controller'
import { lazyWithRetry } from '@/app-shell/startup/lazy-with-retry'
import { useLatchedOpen } from '@/app-shell/root-surfaces/use-latched-open'
import { getTitlebarSidebarToggle } from '@/app-shell/chrome/titlebar-sidebar-toggle-ref'
import { APP_RAIL_ICON_SIZE, APP_RAIL_ICON_STROKE_WIDTH, AppRailButton } from './AppRailButton'

const LazyAppRailAccountMenuContent = lazyWithRetry(
  () =>
    import('./AppRailAccountMenuContent').then((module) => ({
      default: module.AppRailAccountMenuContent
    })),
  { reloadKey: 'app-rail-account-menu-content' }
)

const LazyOrcaProfileSignOutConfirmDialog = lazyWithRetry(
  () =>
    import('@/components/orca-profiles/OrcaProfileSignOutConfirmDialog').then((module) => ({
      default: module.OrcaProfileSignOutConfirmDialog
    })),
  { reloadKey: 'orca-profile-sign-out-confirm-dialog' }
)

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

/**
 * The rail's one bottom button: the account avatar (signed in) or the Settings gear (signed out), opening one flat
 * menu with the account, Milestones, Settings, every Help row and Sign in/out. It never folds into More. The signed-out
 * gear is the same icon the rail's Settings button used.
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
  const setupDescriptionId = useId()
  // The sign-out dialog opens from a menu row, so it has no trigger of its own to hand focus back to.
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const viewAtOpenRef = useRef<string | null>(null)
  // The account button, or, if the rail went away while the dialog was open, the titlebar's sidebar toggle (the same
  // fallback the rail uses when it unmounts with focus).
  const signOutReturnTarget = (): HTMLElement | null =>
    triggerRef.current?.isConnected ? triggerRef.current : getTitlebarSidebarToggle()
  const [menuOpen, setMenuOpen] = useState(false)
  const hasOpenedMenu = useLatchedOpen(menuOpen)
  const [signOutOpen, setSignOutOpen] = useState(false)
  const hasOpenedSignOut = useLatchedOpen(signOutOpen)
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

  // The avatar has no tile behind it: its fill strengthens on hover, and open/active add a ring.
  const face = account ? (
    <span
      aria-hidden
      className={cn(
        'flex size-5 shrink-0 items-center justify-center rounded-full bg-foreground/15 text-[10px] font-semibold text-foreground transition-[background-color,box-shadow]',
        'group-hover:bg-foreground/25 group-aria-expanded:bg-foreground/25 group-aria-expanded:ring-1 group-aria-expanded:ring-foreground/50 group-aria-[current=page]:bg-foreground/25 group-aria-[current=page]:ring-1 group-aria-[current=page]:ring-foreground/50',
        // Forced colors drop the fill, so outline the circle and mark open/active with the system highlight.
        'forced-colors:border forced-colors:border-[CanvasText] forced-colors:group-aria-expanded:border-2 forced-colors:group-aria-expanded:border-[Highlight] forced-colors:group-aria-[current=page]:border-2 forced-colors:group-aria-[current=page]:border-[Highlight]'
      )}
    >
      {account.initial}
    </span>
  ) : (
    <Settings size={APP_RAIL_ICON_SIZE} strokeWidth={APP_RAIL_ICON_STROKE_WIDTH} aria-hidden />
  )

  return (
    <>
      <DropdownMenu
        modal={false}
        open={menuOpen}
        onOpenChange={(open) => {
          if (open) {
            viewAtOpenRef.current = useAppStore.getState().activeView
          }
          setMenuOpen(open)
          help.handleMenuOpenChange(open)
        }}
      >
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <AppRailButton
                ref={triggerRef}
                itemId="account"
                label={label}
                // Setup progress shows as the menu's Milestones row; screen readers also hear it on the button.
                aria-describedby={milestones ? setupDescriptionId : undefined}
                active={settingsActive}
                tile={!account}
                className={account ? 'group' : undefined}
                tabStop={tabStop}
                icon={face}
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
        {hasOpenedMenu ? (
          <React.Suspense fallback={null}>
            <LazyAppRailAccountMenuContent
              account={account}
              help={help}
              milestones={milestones}
              settingsActive={settingsActive}
              settingsLabel={settingsLabel}
              onOpenSettings={onOpenSettings}
              onRequestSignOut={() => setSignOutOpen(true)}
              triggerRef={triggerRef}
              viewAtOpenRef={viewAtOpenRef}
            />
          </React.Suspense>
        ) : null}
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
      {hasOpenedSignOut ? (
        <React.Suspense fallback={null}>
          <LazyOrcaProfileSignOutConfirmDialog
            open={signOutOpen}
            onOpenChange={setSignOutOpen}
            onConfirm={() => void confirmSignOut()}
            signingOut={signingOut}
            returnFocusTo={signOutReturnTarget}
          />
        </React.Suspense>
      ) : null}
    </>
  )
}
