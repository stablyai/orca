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
import { translate } from '@/i18n/i18n'
import { STATUS_BAR_CONTEXT_MENU_EXEMPT_PROPS } from './status-bar-context-menu-policy'
import { AccountRuntimeToggle, CodexRestartStatusPrompt } from './StatusBarAccountControls'
import {
  InlineUsageBars,
  InlineUsageSignInAction,
  InlineUsageSkeleton,
  isUnavailableInactiveUsage
} from './InlineProviderUsage'
import { ProviderDetailsMenu } from './ProviderDetailsMenu'
import { AccountSwitchList } from './AccountSwitchList'
import { AccountSwitchRowItem } from './AccountSwitchRowItem'
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
    switchGroups
  } = useCodexSwitcherController(codex)

  return (
    <ProviderDetailsMenu
      provider={codex}
      compact={compact}
      iconOnly={iconOnly}
      asSubmenu={asSubmenu}
      triggerContent={triggerContent}
      ariaLabel={translate(
        'auto.components.status.bar.StatusBar.ba55303942',
        'Open Codex details and account switcher'
      )}
      variant="account"
      accountLabel={
        !hasActiveRuntimeEnvironment
          ? (activeTarget?.label ??
            translate('auto.components.status.bar.StatusBar.c676918adc', 'System default'))
          : undefined
      }
      panelFooter={
        resetCreditCount !== null ? (
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0 text-2xs text-muted-foreground">
              {translate(
                'auto.components.status.bar.StatusBar.rateLimitResetsAvailable',
                '{{count}} rate-limit resets available',
                {
                  count: resetCreditCount,
                  defaultValue_one: '{{count}} rate-limit reset available'
                }
              )}
              {resetCreditExpiry ? <div>{resetCreditExpiry}</div> : null}
            </div>
            {canRedeemReset ? (
              <DropdownMenuItem
                asChild
                disabled={isRedeemingReset}
                onSelect={(event) => {
                  event.preventDefault()
                  handleResetMenuSelect()
                }}
              >
                <Button variant="outline" size="xs" disabled={isRedeemingReset}>
                  {isRedeemingReset ? <Loader2 className="size-3.5 animate-spin" /> : null}
                  {isRedeemingReset
                    ? translate('auto.components.status.bar.StatusBar.25d8bbde69', 'Using reset…')
                    : translate('auto.components.status.bar.StatusBar.e159fc1fd7', 'Reset now')}
                </Button>
              </DropdownMenuItem>
            ) : null}
          </div>
        ) : undefined
      }
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
            <Button variant="ghost" onClick={() => setResetConfirmOpen(false)}>
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
      {open ? <CodexRestartStatusPrompt /> : null}
      <AccountSwitchList
        heading={translate('auto.components.status.bar.StatusBar.7657e3db9c', 'Codex Account')}
      >
        {selectedGroup ? (
          <>
            {selectedGroup.targets.map((target) => {
              const inactiveUsage = target.id
                ? inactiveCodexAccounts.find((a) => a.accountId === target.id)
                : null
              // Why: sign-in spawns a local `codex login`, so a remote-owned account can't be re-authed from this desktop.
              const showSignInAction =
                !hasActiveRuntimeEnvironment &&
                !target.active &&
                target.id !== null &&
                isUnavailableInactiveUsage(inactiveUsage?.rateLimits)
              const isSigningIn = reauthenticatingAccountId === target.id
              const isBusy = isSwitching || reauthenticatingAccountId !== null

              return (
                <AccountSwitchRowItem
                  label={target.label}
                  active={target.active}
                  key={`${selectedGroup.key}:${target.id ?? 'system'}`}
                  onSelect={(event) => {
                    // Why: keep the menu open so the follow-up "restart live Codex tabs" prompt stays in this interaction.
                    event.preventDefault()
                    if (!target.active) {
                      void handleSelectAccount(target.id, target.runtimeTarget)
                    }
                  }}
                  disabled={isBusy || target.active}
                  action={
                    showSignInAction ? (
                      <InlineUsageSignInAction
                        accountLabel={target.label}
                        isFetching={inactiveUsage?.isFetching ?? false}
                        isSigningIn={isSigningIn}
                        disabled={isBusy}
                        onSignIn={() => {
                          if (target.id !== null) {
                            void handleSignInAccount(target.id, target.runtimeTarget)
                          }
                        }}
                      />
                    ) : undefined
                  }
                >
                  {!showSignInAction ? (
                    <div className="flex w-full min-w-0 flex-col gap-0.5">
                      {/* Why: rows follow this desktop's codexTarget, so a remote owner's usage could land on the wrong row. */}
                      {target.active && !hasActiveRuntimeEnvironment ? (
                        <InlineUsageBars limits={codex} isFetching={codex.status === 'fetching'} />
                      ) : inactiveUsage?.isFetching && !inactiveUsage.rateLimits ? (
                        <InlineUsageSkeleton />
                      ) : inactiveUsage?.rateLimits ? (
                        <InlineUsageBars
                          limits={inactiveUsage.rateLimits}
                          isFetching={inactiveUsage.isFetching}
                        />
                      ) : null}
                    </div>
                  ) : null}
                </AccountSwitchRowItem>
              )
            })}
          </>
        ) : null}
      </AccountSwitchList>
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
