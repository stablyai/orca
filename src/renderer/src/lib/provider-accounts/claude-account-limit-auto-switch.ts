import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store/index'
import { selectClaudeProviderAccount } from '@/runtime/provider-accounts/observations/runtime-provider-accounts-client'
import {
  accountLimitUsedPercent,
  decideAccountLimitSwitch,
  resolveAccountAutoSwitchThreshold
} from '../../../../shared/agent-usage/rate-limits/account-limit-auto-switch'
import type { ClaudeRateLimitAccountsState } from '../../../../shared/agent-accounts/managed-account-types'
import { getClaudeAccountLabel } from './claude-account-label'
import { handleRunningClaudeSessionsAfterSwitch } from './claude-account-switch-sessions'

// Why: matches main's inactive-usage debounce, so a full roster isn't re-read on every poll.
const RECHECK_INTERVAL_MS = 60_000
const HOST_TARGET = { runtime: 'host', wslDistro: null } as const

function hostAccountId(state: ClaudeRateLimitAccountsState): string | null {
  return state.activeAccountIdsByRuntime?.host ?? state.activeAccountId ?? null
}

/** Selects another local host Claude account once the selected one reaches the user's threshold. */
export function registerClaudeAccountLimitAutoSwitch(unsubs: (() => void)[]): void {
  let checking = false
  let lastCheckAt = 0
  // Why: the "no account left" warning shows once per account, not on every poll.
  let warnedAccountId: string | null | undefined

  const check = async (): Promise<void> => {
    const { settings, rateLimits } = useAppStore.getState()
    if (!settings?.claudeAccountAutoSwitchAtLimit || settings.claudeOAuthUsageEnabled === false) {
      return
    }
    const threshold = resolveAccountAutoSwitchThreshold(
      settings.claudeAccountAutoSwitchThresholdPercent
    )
    const used = accountLimitUsedPercent(rateLimits.claude)
    if (rateLimits.claudeTarget.runtime !== 'host' || used === null || used < threshold) {
      if (used !== null && used < threshold) {
        warnedAccountId = undefined
      }
      return
    }
    if (checking || Date.now() - lastCheckAt < RECHECK_INTERVAL_MS) {
      return
    }
    checking = true
    lastCheckAt = Date.now()
    try {
      await switchIfAtLimit(threshold)
    } catch (error) {
      console.error('[claude-account-auto-switch] switch failed:', error)
      toast.error(
        translate(
          'accounts.claude.autoSwitch.failed',
          'Orca could not switch your Claude account automatically.'
        )
      )
    } finally {
      checking = false
    }
  }

  const switchIfAtLimit = async (threshold: number): Promise<void> => {
    // Why fresh reads: other accounts' usage is otherwise read only when a switcher opens.
    await window.api.rateLimits.fetchInactiveClaudeAccounts()
    const [usage, before] = await Promise.all([
      window.api.rateLimits.get(),
      window.api.claudeAccounts.list()
    ])
    const activeId = hostAccountId(before)
    const reading = usage.claude?.usageMetadata?.readingAccount
    // Why: right after a switch the reading may still belong to the previous account.
    if (usage.claudeTarget.runtime !== 'host' || (reading && reading.accountId !== activeId)) {
      return
    }
    const inactiveUsage = new Map(
      usage.inactiveClaudeAccounts.map((entry) => [entry.accountId, entry.rateLimits])
    )
    const decision = decideAccountLimitSwitch({
      active: usage.claude,
      thresholdPercent: threshold,
      candidates: before.accounts
        .filter(
          (account) =>
            account.id !== activeId && account.managedAuthRuntime !== 'wsl' && !account.needsSignIn
        )
        .map((account) => ({ accountId: account.id, limits: inactiveUsage.get(account.id) }))
    })
    if (decision.kind === 'under-limit') {
      warnedAccountId = undefined
      return
    }
    const previous = getClaudeAccountLabel(before, activeId)
    const previousUsed = Math.round(accountLimitUsedPercent(usage.claude) ?? threshold)
    if (decision.kind === 'no-account-under-limit') {
      if (warnedAccountId !== activeId) {
        warnedAccountId = activeId
        toast.warning(
          translate(
            'accounts.claude.autoSwitch.noAccountTitle',
            '{{previous}} is at {{used}}% of its Claude limit',
            { previous, used: previousUsed }
          ),
          {
            description: translate(
              'accounts.claude.autoSwitch.noAccountDescription',
              'No other signed-in Claude account is below {{threshold}}%, so Orca kept this one.',
              { threshold }
            )
          }
        )
      }
      return
    }
    const { runningSessions, ...after } = await selectClaudeProviderAccount(
      { kind: 'local' },
      { accountId: decision.accountId, ...HOST_TARGET }
    )
    warnedAccountId = undefined
    await useAppStore.getState().fetchSettings()
    const nextAccountId = hostAccountId(after)
    toast.info(
      translate('accounts.claude.autoSwitch.switchedTitle', 'Switched Claude to {{next}}', {
        next: getClaudeAccountLabel(after, nextAccountId)
      }),
      {
        description: translate(
          'accounts.claude.autoSwitch.switchedDescription',
          '{{previous}} reached {{used}}% of its limit. New Claude sessions start on the new account.',
          { previous, used: previousUsed }
        )
      }
    )
    // Running sessions follow the "When you switch accounts" setting, as with a manual switch.
    void handleRunningClaudeSessionsAfterSwitch({
      owner: { kind: 'local' },
      target: HOST_TARGET,
      before: { state: before, accountId: activeId },
      after: { state: after, accountId: nextAccountId },
      ...(runningSessions ? { hostMove: runningSessions } : {})
    })
  }

  unsubs.push(
    useAppStore.subscribe((state, previousState) => {
      if (
        state.rateLimits !== previousState.rateLimits ||
        state.settings !== previousState.settings
      ) {
        void check()
      }
    })
  )
}
