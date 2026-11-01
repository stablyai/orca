import type { Dispatch, SetStateAction } from 'react'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import type { FeatureInteractionId } from '../../../../shared/feature-interaction-catalog'
import type {
  ClaudeRateLimitAccountsState,
  CodexRateLimitAccountsState
} from '../../../../shared/managed-account-types'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import {
  markLiveCodexSessionsForRestart,
  resolveCodexRestartPromptAccountLabel
} from '@/lib/codex-session-restart'
import {
  getProviderAccountActiveIdForView,
  getProviderAccountRuntime
} from './provider-account-visibility'
import type {
  ClaudeAccountAction,
  ClaudeAccountActionRunner,
  CodexAccountAction,
  CodexAccountActionRunner,
  LocalAccountRuntime
} from './accounts-pane-types'
import {
  getClaudeAccountErrorDescription,
  getCodexAccountErrorDescription,
  isClaudeAccountCancellation,
  isCodexAccountCancellation
} from './accounts-pane-action-errors'
import { getClaudeAccountLabel } from '@/lib/claude-account-label'
import { handleRunningClaudeSessionsAfterSwitch } from '@/lib/claude-account-switch-sessions'

type CodexActionContext = {
  settings: GlobalSettings
  /** Host whose roster the action writes. */
  accountOwner: RuntimeClientTarget
  accountRuntime: LocalAccountRuntime
  isRemoteAccountScope: boolean
  codexAccounts: CodexRateLimitAccountsState
  setCodexAccounts: Dispatch<SetStateAction<CodexRateLimitAccountsState>>
  setCodexAccountsLoaded: Dispatch<SetStateAction<boolean>>
  setCodexAction: Dispatch<SetStateAction<CodexAccountAction>>
  fetchSettings: () => Promise<void>
  recordFeatureInteraction: (featureId: FeatureInteractionId) => void
  /** False once the pane shows a different account owner than this action targeted. */
  isCurrentAccountOwner: () => boolean
}

export function createCodexAccountActionRunner(
  context: CodexActionContext
): CodexAccountActionRunner {
  const {
    accountOwner,
    accountRuntime,
    codexAccounts,
    fetchSettings,
    isCurrentAccountOwner,
    isRemoteAccountScope,
    recordFeatureInteraction,
    setCodexAccounts,
    setCodexAccountsLoaded,
    setCodexAction
  } = context
  const syncCodexAccounts = async (next: CodexRateLimitAccountsState): Promise<void> => {
    // Scope roster updates to the shown owner; action toasts/follow-ups still belong to the original operation.
    if (isCurrentAccountOwner()) {
      setCodexAccounts(next)
      setCodexAccountsLoaded(true)
    }
    // Remote account mutations do not change local GlobalSettings.
    if (!isRemoteAccountScope) {
      await fetchSettings()
    }
  }

  // Remote Windows combines host/WSL rows; compare the selected row’s runtime slot, not the forced host view.
  return async (action, operation, actionRuntime = accountRuntime): Promise<void> => {
    const previousActiveAccountId = getProviderAccountActiveIdForView(codexAccounts, actionRuntime)
    setCodexAction(action)
    try {
      const next = await operation()
      await syncCodexAccounts(next)
      recordFeatureInteraction('codex-account-switching')
      const nextActiveAccountId = getProviderAccountActiveIdForView(next, actionRuntime)
      const shouldPromptRestart =
        action === 'adding' ||
        (action.startsWith('select:') && previousActiveAccountId !== nextActiveAccountId) ||
        (action.startsWith('reauth:') &&
          nextActiveAccountId !== null &&
          action === `reauth:${nextActiveAccountId}`) ||
        (action.startsWith('remove:') && previousActiveAccountId !== nextActiveAccountId)
      if (shouldPromptRestart) {
        // Find the newly created account’s concrete distro from the roster diff; the row may say WSL default and active-ID lookup becomes ambiguous across distro slots.
        const newAccounts =
          action === 'adding'
            ? next.accounts.filter(
                (account) => !codexAccounts.accounts.some((prior) => prior.id === account.id)
              )
            : []
        // Require exactly one addition; unloaded prior rosters make all accounts look new, so retain the existing row fallback when ambiguous.
        const addedAccount = newAccounts.length === 1 ? newAccounts[0] : undefined
        void markLiveCodexSessionsForRestart({
          previousAccountLabel: resolveCodexRestartPromptAccountLabel(
            codexAccounts.accounts,
            previousActiveAccountId
          ),
          nextAccountLabel: resolveCodexRestartPromptAccountLabel(
            next.accounts,
            nextActiveAccountId
          ),
          // Emails can repeat; use IDs to detect returning to the launch account.
          previousAccountId: previousActiveAccountId ?? null,
          nextAccountId: nextActiveAccountId ?? null,
          // Only this runtime slot changed; other lanes retain their launch accounts.
          owner: accountOwner,
          target: addedAccount ? getProviderAccountRuntime(addedAccount) : actionRuntime,
          // Clearing distro-less WSL resets every distro slot.
          clearsEveryWslDistro: action === 'select:system'
        })
      }
    } catch (error) {
      // Explicit cancellation and superseding logins are user actions, not failures.
      if (isCodexAccountCancellation(error)) {
        return
      }
      toast.error(
        translate(
          'auto.components.settings.AccountsPane.5bf8764953',
          'Codex account update failed.'
        ),
        {
          description: getCodexAccountErrorDescription(error)
        }
      )
    } finally {
      setCodexAction('idle')
    }
  }
}

type ClaudeActionContext = {
  /** Host whose roster the action writes. */
  accountOwner: RuntimeClientTarget
  accountRuntime: LocalAccountRuntime
  isRemoteAccountScope: boolean
  claudeAccounts: ClaudeRateLimitAccountsState
  setClaudeAccounts: Dispatch<SetStateAction<ClaudeRateLimitAccountsState>>
  setClaudeAction: Dispatch<SetStateAction<ClaudeAccountAction>>
  fetchSettings: () => Promise<void>
  recordFeatureInteraction: (featureId: FeatureInteractionId) => void
  /** False once the pane shows a different account owner than this action targeted. */
  isCurrentAccountOwner: () => boolean
}

export function createClaudeAccountActionRunner(
  context: ClaudeActionContext
): ClaudeAccountActionRunner {
  const {
    accountOwner,
    accountRuntime,
    claudeAccounts,
    fetchSettings,
    isCurrentAccountOwner,
    isRemoteAccountScope,
    recordFeatureInteraction,
    setClaudeAccounts,
    setClaudeAction
  } = context
  const syncClaudeAccounts = async (next: ClaudeRateLimitAccountsState): Promise<void> => {
    if (isCurrentAccountOwner()) {
      setClaudeAccounts(next)
    }
    if (!isRemoteAccountScope) {
      await fetchSettings()
    }
  }

  return async (action, operation, actionRuntime = accountRuntime): Promise<void> => {
    const previousActiveAccountId = getProviderAccountActiveIdForView(claudeAccounts, actionRuntime)
    setClaudeAction(action)
    try {
      const next = await operation()
      await syncClaudeAccounts(next)
      recordFeatureInteraction('claude-account-switching')
      const nextActiveAccountId = getProviderAccountActiveIdForView(next, actionRuntime)
      const switched = previousActiveAccountId !== nextActiveAccountId
      const showUpdatedToast = (): void => {
        toast.info(
          translate('auto.components.settings.AccountsPane.f921d32606', 'Claude account updated.'),
          {
            description: switched
              ? translate(
                  'accounts.claude.nextLaunch',
                  '{{value0}} → {{value1}}. The next Claude terminal you start uses it. Running Claude terminals keep their account.',
                  {
                    value0: getClaudeAccountLabel(claudeAccounts, previousActiveAccountId),
                    value1: getClaudeAccountLabel(next, nextActiveAccountId)
                  }
                )
              : translate(
                  'accounts.claude.added',
                  'Account added. Select it to use it for the next Claude you start.'
                )
          }
        )
      }
      if (switched) {
        void handleRunningClaudeSessionsAfterSwitch({
          owner: accountOwner,
          target: actionRuntime,
          before: { state: claudeAccounts, accountId: previousActiveAccountId },
          after: { state: next, accountId: nextActiveAccountId }
        }).then((outcome) => {
          if (outcome === 'show-confirmation') {
            showUpdatedToast()
          }
        })
      } else if (action === 'adding') {
        showUpdatedToast()
      }
    } catch (error) {
      if (isClaudeAccountCancellation(error)) {
        return
      }
      toast.error(
        translate(
          'auto.components.settings.AccountsPane.2743cdc0af',
          'Claude account update failed.'
        ),
        {
          description: getClaudeAccountErrorDescription(error)
        }
      )
    } finally {
      setClaudeAction('idle')
    }
  }
}
