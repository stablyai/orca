import React from 'react'
import { Loader2, LogIn, LogOut, Settings } from 'lucide-react'
import { useAppStore } from '@/store/index'
import { cn } from '@/lib/class-names'
import { useTranslate } from '@/i18n/use-translate'
import { useOptionalShortcutLabel } from '@/lib/keyboard/useShortcutLabel'
import {
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut
} from '@/components/ui/dropdown-menu'
import {
  MilestonesMenuItem,
  type HelpMenuController,
  type SetupMilestones
} from '@/components/sidebar/chrome/help-menu-controller'
import { refocusTriggerIfFocusLost } from './app-rail-menu-focus'
import type { AppRailAccount } from './AppRailAccountMenu'

export type AppRailAccountMenuContentProps = {
  account: AppRailAccount | null
  help: HelpMenuController
  milestones: SetupMilestones | null
  settingsActive: boolean
  settingsLabel: string
  onOpenSettings: () => void
  onRequestSignOut: () => void
  triggerRef: React.RefObject<HTMLButtonElement | null>
  viewAtOpenRef: React.RefObject<string | null>
}

export function AppRailAccountMenuContent({
  account,
  help,
  milestones,
  settingsActive,
  settingsLabel,
  onOpenSettings,
  onRequestSignOut,
  triggerRef,
  viewAtOpenRef
}: AppRailAccountMenuContentProps): React.JSX.Element {
  const t = useTranslate()
  const canSignIn = useAppStore((s) => s.orcaProfileAuthStatus?.configured === true)
  const reconnect = useAppStore((s) => s.orcaProfileAuthStatus?.state === 'reconnect-required')
  const signingIn = useAppStore((s) => Boolean(s.orcaProfileSignInProgress))
  const settingsShortcut = useOptionalShortcutLabel('app.settings')

  return (
    <DropdownMenuContent
      side="right"
      align="end"
      sideOffset={8}
      className="w-52"
      onCloseAutoFocus={(event) => {
        // Why: Settings and Keyboard Shortcuts open the settings page, which focuses its search (or the deep-linked
        // pane). Radix refocuses the trigger in a timeout after closing, which could land after the page's own
        // focus; yielding lets the page keep it.
        if (
          useAppStore.getState().activeView === 'settings' &&
          viewAtOpenRef.current !== 'settings'
        ) {
          event.preventDefault()
        }
        // If nothing took focus a frame later, hand it back to the button: a deep link (Keyboard Shortcuts) turns
        // off the page's search autofocus and its pane takes none, and a click on blank space leaves the body.
        refocusTriggerIfFocusLost(triggerRef.current)
      }}
    >
      {account ? (
        <div className="flex min-w-0 items-center gap-2 px-1.5 py-1.5">
          <span
            aria-hidden
            className={cn(
              'flex shrink-0 items-center justify-center rounded-full bg-foreground/15 font-semibold text-foreground size-5 text-[10px]'
            )}
          >
            {account.initial}
          </span>
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
        {settingsShortcut ? <DropdownMenuShortcut>{settingsShortcut}</DropdownMenuShortcut> : null}
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      {help.items}
      {account ? (
        <>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={onRequestSignOut}>
            <LogOut className="size-3.5" />
            {t('auto.components.settings.orcaAccount.signOut', 'Sign out')}
          </DropdownMenuItem>
        </>
      ) : null}
    </DropdownMenuContent>
  )
}
