import React from 'react'
import { CodexResetCredits, CodexResetConfirmation } from './CodexResetCredits'
import { DropdownMenuItem, DropdownMenuLabel } from '@/components/ui/dropdown-menu'
import type { ProviderRateLimits } from '../../../../shared/rate-limit-types'
import { useTranslate } from '@/i18n/use-translate'
import { AccountRuntimeToggle, CodexRestartStatusPrompt } from './StatusBarAccountControls'
import {
  InlineUsageBars,
  InlineUsageSignInAction,
  InlineUsageSkeleton,
  isUnavailableInactiveUsage
} from './InlineProviderUsage'
import { ProviderDetailsMenu } from './ProviderDetailsMenu'
import { AccountSwitchSection } from './AccountSwitchList'
import { AccountSwitchRowItem } from './AccountSwitchRowItem'
import { useCodexSwitcherController } from './use-codex-switcher-controller'
import type { OwnerUsageRateLimits } from './use-owner-usage-rate-limits'

export function CodexSwitcherMenu({
  codex,
  ownerUsage,
  compact,
  iconOnly,
  asSubmenu = false,
  triggerContent
}: {
  codex: ProviderRateLimits
  ownerUsage?: OwnerUsageRateLimits
  compact: boolean
  iconOnly: boolean
  asSubmenu?: boolean
  triggerContent?: React.ReactNode
}): React.JSX.Element {
  const t = useTranslate()
  const {
    activeTarget,
    activeUsage,
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
  } = useCodexSwitcherController(codex, ownerUsage)

  const isBusy = isSwitching || reauthenticatingAccountId !== null
  const rows = (selectedGroup?.targets ?? []).map((target) => {
    const inactiveUsage = target.id
      ? inactiveCodexAccounts.find((a) => a.accountId === target.id)
      : null
    // Why: sign-in spawns a local `codex login`, so a remote-owned account can't be re-authed from this desktop.
    const showSignInAction =
      !hasActiveRuntimeEnvironment &&
      !target.active &&
      target.id !== null &&
      isUnavailableInactiveUsage(inactiveUsage?.rateLimits)
    return { target, inactiveUsage, showSignInAction }
  })
  const unavailableUsageRows = rows.filter((row) => row.showSignInAction)
  const renderRow = ({
    target,
    inactiveUsage,
    showSignInAction
  }: (typeof rows)[number]): React.JSX.Element => (
    <AccountSwitchRowItem
      label={target.name}
      detail={target.detail}
      active={target.active}
      key={`${selectedGroup?.key}:${target.id ?? 'system'}`}
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
            isSigningIn={reauthenticatingAccountId === target.id}
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
      {showSignInAction ? null : renderUsage(target.active, inactiveUsage)}
    </AccountSwitchRowItem>
  )
  function renderUsage(
    active: boolean,
    inactiveUsage: (typeof rows)[number]['inactiveUsage']
  ): React.ReactNode {
    if (active && activeUsage) {
      return <InlineUsageBars limits={activeUsage} isFetching={activeUsage.status === 'fetching'} />
    }
    if (inactiveUsage?.isFetching && !inactiveUsage.rateLimits) {
      return <InlineUsageSkeleton />
    }
    return inactiveUsage?.rateLimits ? (
      <InlineUsageBars limits={inactiveUsage.rateLimits} isFetching={inactiveUsage.isFetching} />
    ) : null
  }

  return (
    <ProviderDetailsMenu
      provider={codex}
      compact={compact}
      iconOnly={iconOnly}
      asSubmenu={asSubmenu}
      triggerContent={triggerContent}
      ariaLabel={t(
        'auto.components.status.bar.StatusBar.ba55303942',
        'Open Codex details and account switcher'
      )}
      variant="account"
      accountLabel={
        activeUsage
          ? (activeTarget?.label ??
            t('auto.components.status.bar.StatusBar.c676918adc', 'System default'))
          : undefined
      }
      panelFooter={
        resetCreditCount !== null ? (
          <CodexResetCredits
            resetCreditCount={resetCreditCount}
            resetCreditExpiry={resetCreditExpiry}
            canRedeemReset={canRedeemReset}
            isRedeemingReset={isRedeemingReset}
            onReset={handleResetMenuSelect}
            renderAction={(action) => (
              <DropdownMenuItem
                asChild
                disabled={isRedeemingReset}
                onSelect={(event) => {
                  event.preventDefault()
                }}
              >
                {action}
              </DropdownMenuItem>
            )}
          />
        ) : undefined
      }
      topContent={
        <AccountRuntimeToggle
          groups={switchGroups}
          value={selectedGroup?.key ?? selectedRuntimeKey}
          onChange={(group) => void handleSelectRuntime(group)}
          ariaLabel={t('auto.components.status.bar.StatusBar.38b5647724', 'Codex usage runtime')}
        />
      }
      open={open}
      onOpenChange={handleOpenChange}
    >
      <CodexResetConfirmation
        open={resetConfirmOpen}
        onOpenChange={setResetConfirmOpen}
        skipFutureResetConfirm={skipFutureResetConfirm}
        onSkipChange={setSkipFutureResetConfirm}
        isRedeemingReset={isRedeemingReset}
        onConfirm={handleConfirmReset}
      />
      {open ? <CodexRestartStatusPrompt /> : null}
      <AccountSwitchSection
        heading={t('auto.components.status.bar.StatusBar.7657e3db9c', 'Codex Account')}
        targets={selectedGroup?.targets ?? []}
        panelShowsActiveAccount={activeUsage !== null}
        onOpenSettings={() => {
          openSettingsTarget({
            pane: 'accounts',
            repoId: null,
            sectionId: 'accounts-codex'
          })
          openSettingsPage()
        }}
      >
        {rows.filter((row) => !row.showSignInAction).map(renderRow)}
        {unavailableUsageRows.length > 0 ? (
          <>
            <DropdownMenuLabel className="mt-1">
              {t('auto.components.status.bar.tooltip.f8b8dbed85', 'Usage unavailable')}
            </DropdownMenuLabel>
            {unavailableUsageRows.map(renderRow)}
          </>
        ) : null}
      </AccountSwitchSection>
    </ProviderDetailsMenu>
  )
}
