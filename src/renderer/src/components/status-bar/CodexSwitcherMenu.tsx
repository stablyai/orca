import { Loader2, RotateCcw } from 'lucide-react'
import React from 'react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { DropdownMenuItem, DropdownMenuSeparator } from '@/components/ui/dropdown-menu'
import type { ProviderRateLimits } from '../../../../shared/rate-limit-types'
import { normalizeUsagePercentageDisplay } from '../../../../shared/usage-percentage-display'
import { useAppStore } from '../../store'
import { translate } from '@/i18n/i18n'
import { STATUS_BAR_CONTEXT_MENU_EXEMPT_PROPS } from './status-bar-context-menu-policy'
import { AccountRuntimeToggle, CodexRestartStatusPrompt } from './StatusBarAccountControls'
import { AccountIdentityHeader } from './AccountIdentityHeader'
import {
  AccountSwitchList,
  getAccountSwitchStatusLabel,
  type AccountSwitchListRow
} from './AccountSwitchList'
import { getAccountSwitchUsage, isUnavailableInactiveUsage } from './account-switch-row-model'
import { ProviderDetailsMenu } from './ProviderDetailsMenu'
import { useCodexSwitcherController } from './use-codex-switcher-controller'

export function CodexSwitcherMenu({
  codex,
  compact,
  iconOnly,
  asSubmenu = false,
  triggerContent
}: {
  codex: ProviderRateLimits
  compact: boolean
  iconOnly: boolean
  asSubmenu?: boolean
  triggerContent?: React.ReactNode
}): React.JSX.Element {
  const {
    activeTarget,
    canRedeemReset,
    handleConfirmReset,
    handleOpenChange,
    handleResetMenuSelect,
    handleSelectAccount,
    handleSelectRuntime,
    handleSignInAccount,
    hasActiveRuntimeEnvironment,
    inactiveCodexAccounts,
    isRedeemingReset,
    isSwitching,
    open,
    openSettingsPage,
    openSettingsTarget,
    reauthenticatingAccountId,
    resetConfirmOpen,
    resetCreditCount,
    resetCreditExpiry,
    selectedGroup,
    selectedRuntimeKey,
    setResetConfirmOpen,
    setSkipFutureResetConfirm,
    skipFutureResetConfirm,
    suppressNextAccountSelect,
    suppressNextAccountSelectRef,
    switchGroups
  } = useCodexSwitcherController(codex)
  const usagePercentageDisplay = normalizeUsagePercentageDisplay(
    useAppStore((state) => state.usagePercentageDisplay)
  )
  const isBusy = isSwitching || reauthenticatingAccountId !== null

  const accountRows: AccountSwitchListRow[] = (selectedGroup?.targets ?? []).map((target) => {
    const inactiveUsage = target.id
      ? inactiveCodexAccounts.find((a) => a.accountId === target.id)
      : null
    // Why: sign-in spawns a local `codex login`, so a remote-owned account can't be re-authed from this desktop.
    const showSignInAction =
      !hasActiveRuntimeEnvironment &&
      !target.active &&
      target.id !== null &&
      isUnavailableInactiveUsage(inactiveUsage?.rateLimits)
    // Why: rows follow this desktop's codexTarget, so a remote owner's usage could land on the wrong row.
    const limits = target.active
      ? hasActiveRuntimeEnvironment
        ? null
        : codex
      : (inactiveUsage?.rateLimits ?? null)
    const usage = getAccountSwitchUsage(limits)
    return {
      key: `${selectedGroup?.key}:${target.id ?? 'system'}`,
      title: target.label,
      email: target.email,
      systemDefaultEmail: target.systemDefaultEmail,
      workspace: target.workspace ?? null,
      identifier: target.identifier ?? null,
      usage,
      needsSignIn: showSignInAction,
      active: target.active,
      disabled: !target.active && isBusy,
      isFetching: target.active
        ? codex.status === 'fetching'
        : (inactiveUsage?.isFetching ?? false) && !inactiveUsage?.rateLimits,
      statusLabel: showSignInAction ? null : getAccountSwitchStatusLabel(limits),
      hint: null,
      signIn:
        showSignInAction && target.id !== null
          ? {
              isSigningIn: reauthenticatingAccountId === target.id,
              disabled: isBusy,
              onPointerDown: suppressNextAccountSelect,
              onSignIn: () => {
                suppressNextAccountSelect()
                if (target.id !== null) {
                  void handleSignInAccount(target.id, target.runtimeTarget)
                }
              }
            }
          : null,
      onSelect: () => {
        if (suppressNextAccountSelectRef.current) {
          suppressNextAccountSelectRef.current = false
          return
        }
        void handleSelectAccount(target.id, target.runtimeTarget)
      }
    }
  })

  const resetSummary =
    resetCreditCount !== null ? (
      <span className="min-w-0 flex-1">
        <span className="block font-medium text-foreground">
          {translate(
            'auto.components.status.bar.StatusBar.rateLimitResetsAvailable',
            '{{count}} rate-limit resets available',
            {
              count: resetCreditCount,
              defaultValue_one: '{{count}} rate-limit reset available'
            }
          )}
        </span>
        {resetCreditExpiry ? (
          <span className="block text-muted-foreground">{resetCreditExpiry}</span>
        ) : null}
      </span>
    ) : null
  // Why a menu item: Radix menus skip Tab, so a plain button here would be unreachable by keyboard.
  const resetRow =
    resetSummary === null ? null : canRedeemReset ? (
      <DropdownMenuItem
        disabled={isRedeemingReset}
        // Why: line the text up with the card's other content; the item's own padding is for menus.
        className="-mx-2.5"
        onSelect={(event) => {
          event.preventDefault()
          handleResetMenuSelect()
        }}
      >
        <span className="flex w-full items-center gap-2 text-xs">
          {resetSummary}
          <span className="inline-flex h-6 shrink-0 items-center gap-1 rounded-md border border-border bg-background px-2 text-foreground">
            {isRedeemingReset ? <Loader2 className="size-3 animate-spin" /> : null}
            {isRedeemingReset
              ? translate('auto.components.status.bar.StatusBar.25d8bbde69', 'Using reset…')
              : translate('auto.components.status.bar.StatusBar.e159fc1fd7', 'Reset now')}
          </span>
        </span>
      </DropdownMenuItem>
    ) : (
      <div className="flex items-center gap-2 text-xs">{resetSummary}</div>
    )

  return (
    <ProviderDetailsMenu
      provider={codex}
      compact={compact}
      iconOnly={iconOnly}
      asSubmenu={asSubmenu}
      triggerContent={triggerContent}
      // Reset credits render beside the action in the card footer; suppress the generic summary’s duplicate.
      hidePanelResetCredits
      wide
      identity={
        // Why: a remote owner's usage may belong to another runtime lane than the row picked here.
        activeTarget && !hasActiveRuntimeEnvironment ? (
          <AccountIdentityHeader
            email={activeTarget.email}
            systemDefaultEmail={activeTarget.systemDefaultEmail}
            workspace={activeTarget.workspace ?? null}
            identifier={activeTarget.identifier ?? null}
          />
        ) : undefined
      }
      panelFooter={resetRow}
      ariaLabel={translate(
        'auto.components.status.bar.StatusBar.ba55303942',
        'Open Codex details and account switcher'
      )}
      topContent={
        <AccountRuntimeToggle
          groups={switchGroups}
          value={selectedGroup?.key ?? selectedRuntimeKey}
          onChange={(group) => void handleSelectRuntime(group)}
          ariaLabel={translate(
            'auto.components.status.bar.StatusBar.38b5647724',
            'Codex usage runtime'
          )}
        />
      }
      open={open}
      onOpenChange={handleOpenChange}
    >
      <Dialog open={resetConfirmOpen} onOpenChange={setResetConfirmOpen}>
        <DialogContent className="sm:max-w-[420px]" {...STATUS_BAR_CONTEXT_MENU_EXEMPT_PROPS}>
          <DialogHeader>
            <DialogTitle>
              {translate('auto.components.status.bar.StatusBar.972a1ff497', 'Reset Codex limits?')}
            </DialogTitle>
            <DialogDescription>
              {translate(
                'auto.components.status.bar.StatusBar.6d1042aa6f',
                'This uses one Codex rate-limit reset credit for the active account and resets any eligible usage windows immediately.'
              )}
            </DialogDescription>
          </DialogHeader>
          <label className="flex cursor-pointer items-center gap-2 rounded-sm px-1 py-1 text-xs text-foreground/80 transition-colors hover:text-foreground">
            <Checkbox
              checked={skipFutureResetConfirm}
              onCheckedChange={(checked) => setSkipFutureResetConfirm(checked === true)}
            />
            <span>
              {translate('auto.components.status.bar.StatusBar.f077f586db', "Don't ask again")}
            </span>
          </label>
          <DialogFooter>
            <Button variant="outline" onClick={() => setResetConfirmOpen(false)}>
              {translate('auto.components.status.bar.StatusBar.c0e972d726', 'Cancel')}
            </Button>
            <Button onClick={() => void handleConfirmReset()} disabled={isRedeemingReset}>
              {isRedeemingReset ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <RotateCcw className="size-4" />
              )}
              {isRedeemingReset
                ? translate('auto.components.status.bar.StatusBar.25d8bbde69', 'Using reset…')
                : translate('auto.components.status.bar.StatusBar.e159fc1fd7', 'Reset now')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <AccountSwitchList
        heading={translate('auto.components.status.bar.StatusBar.7657e3db9c', 'Codex Account')}
        rows={accountRows}
        display={usagePercentageDisplay}
      />
      {open ? <CodexRestartStatusPrompt /> : null}
      <DropdownMenuSeparator />
      <DropdownMenuItem
        onSelect={() => {
          openSettingsTarget({
            pane: 'accounts',
            repoId: null,
            sectionId: 'accounts-codex'
          })
          openSettingsPage()
        }}
      >
        {translate('auto.components.status.bar.StatusBar.75ded02687', 'Manage Accounts…')}
      </DropdownMenuItem>
    </ProviderDetailsMenu>
  )
}
