import { ChevronDown, ChevronRight, Loader2, RotateCcw } from 'lucide-react'
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
import {
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator
} from '@/components/ui/dropdown-menu'
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
    accountsExpanded,
    activeTarget,
    canRedeemReset,
    handleAccountsExpandedToggle,
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

  return (
    <ProviderDetailsMenu
      provider={codex}
      compact={compact}
      iconOnly={iconOnly}
      asSubmenu={asSubmenu}
      triggerContent={triggerContent}
      // Why: Codex reset credits render beside the reset action below; showing
      // them in the generic provider summary duplicates the same metadata.
      hidePanelResetCredits
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
      {resetCreditCount !== null ? (
        <>
          <DropdownMenuLabel className="space-y-0.5">
            <div>
              {resetCreditCount === 1
                ? translate(
                    'auto.components.status.bar.StatusBar.5e5f9f5160',
                    '1 rate-limit reset available'
                  )
                : translate(
                    'auto.components.status.bar.StatusBar.5ecae9197c',
                    '{{value0}} rate-limit resets available',
                    { value0: resetCreditCount }
                  )}
            </div>
            {resetCreditExpiry ? (
              <div className="text-[11px] font-normal text-muted-foreground">
                {resetCreditExpiry}
              </div>
            ) : null}
          </DropdownMenuLabel>
          {canRedeemReset ? (
            <DropdownMenuItem
              disabled={isRedeemingReset}
              onSelect={(event) => {
                event.preventDefault()
                handleResetMenuSelect()
              }}
            >
              {isRedeemingReset ? (
                <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
              ) : null}
              {isRedeemingReset
                ? translate('auto.components.status.bar.StatusBar.25d8bbde69', 'Using reset…')
                : translate('auto.components.status.bar.StatusBar.e159fc1fd7', 'Reset now')}
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuSeparator />
        </>
      ) : null}
      <DropdownMenuLabel>
        {translate('auto.components.status.bar.StatusBar.7657e3db9c', 'Codex Account')}
      </DropdownMenuLabel>
      <DropdownMenuItem
        onSelect={(event) => {
          event.preventDefault()
          handleAccountsExpandedToggle()
        }}
      >
        <div className="flex min-w-0 flex-1 flex-col gap-0.5 py-0.5 text-[12px]">
          <div className="flex min-w-0 items-center gap-1.5">
            <span className="min-w-0 flex-1 truncate text-foreground">
              {activeTarget?.label ??
                translate('auto.components.status.bar.StatusBar.c676918adc', 'System default')}
            </span>
          </div>
        </div>
        {accountsExpanded ? (
          <ChevronDown className="ml-auto size-3.5 text-muted-foreground/85" />
        ) : (
          <ChevronRight className="ml-auto size-3.5 text-muted-foreground/85" />
        )}
      </DropdownMenuItem>
      {accountsExpanded ? (
        <div className="px-1 pb-1">
          <div className="max-h-[220px] overflow-y-auto rounded-md border border-border/60 bg-accent/5 p-1 scrollbar-sleek">
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
                    <DropdownMenuItem
                      key={`${selectedGroup.key}:${target.id ?? 'system'}`}
                      onSelect={(event) => {
                        // Why: keep the menu open so the follow-up "restart live Codex tabs" prompt stays in this interaction.
                        event.preventDefault()
                        if (suppressNextAccountSelectRef.current) {
                          suppressNextAccountSelectRef.current = false
                          return
                        }
                        if (!target.active) {
                          void handleSelectAccount(target.id, target.runtimeTarget)
                        }
                      }}
                      disabled={isBusy || target.active}
                    >
                      <div className="flex w-full min-w-0 flex-col gap-0.5">
                        <div className="flex min-w-0 items-center gap-2">
                          <span className="min-w-0 flex-1 truncate">{target.label}</span>
                          {target.active ? (
                            <span className="shrink-0 text-[10px] font-medium text-muted-foreground">
                              {translate(
                                'auto.components.status.bar.StatusBar.ff0fbe9311',
                                'Active'
                              )}
                            </span>
                          ) : null}
                        </div>
                        {inactiveUsage?.isFetching && !inactiveUsage.rateLimits ? (
                          <InlineUsageSkeleton />
                        ) : showSignInAction ? (
                          <InlineUsageSignInAction
                            isFetching={inactiveUsage?.isFetching ?? false}
                            isSigningIn={isSigningIn}
                            disabled={isBusy}
                            onSignInPointerDown={suppressNextAccountSelect}
                            onSignIn={() => {
                              suppressNextAccountSelect()
                              if (target.id !== null) {
                                void handleSignInAccount(target.id, target.runtimeTarget)
                              }
                            }}
                          />
                        ) : inactiveUsage?.rateLimits ? (
                          <InlineUsageBars
                            limits={inactiveUsage.rateLimits}
                            isFetching={inactiveUsage.isFetching}
                          />
                        ) : null}
                      </div>
                    </DropdownMenuItem>
                  )
                })}
              </>
            ) : null}
          </div>
        </div>
      ) : null}
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
