import type { Dispatch, SetStateAction } from 'react'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
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
  isClaudeAccountCancellation
} from './accounts-pane-action-errors'
import { getClaudeAccountLabel } from './accounts-pane-runtime'

type CodexActionContext = {
  settings: GlobalSettings
  accountRuntime: LocalAccountRuntime
  isRemoteAccountScope: boolean
  codexAccounts: CodexRateLimitAccountsState
  setCodexAccounts: Dispatch<SetStateAction<CodexRateLimitAccountsState>>
  setCodexAccountsLoaded: Dispatch<SetStateAction<boolean>>
  setCodexAction: Dispatch<SetStateAction<CodexAccountAction>>
  fetchSettings: () => Promise<void>
  recordFeatureInteraction: (featureId: FeatureInteractionId) => void
}

export function createCodexAccountActionRunner(
  context: CodexActionContext
): CodexAccountActionRunner {
  const {
    accountRuntime,
    codexAccounts,
    fetchSettings,
    isRemoteAccountScope,
    recordFeatureInteraction,
    setCodexAccounts,
    setCodexAccountsLoaded,
    setCodexAction
  } = context
  const syncCodexAccounts = async (next: CodexRateLimitAccountsState): Promise<void> => {
    setCodexAccounts(next)
    setCodexAccountsLoaded(true)
    // Why: remote mutations never change local GlobalSettings account fields.
    if (!isRemoteAccountScope) {
      await fetchSettings()
    }
  }

  // Why: remote Windows flattens host and WSL rows, so mutation follow-up must
  // compare the selected row's runtime slot instead of the forced host view.
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
        // Why: `add` creates the managed home against the machine's own distro,
        // so the slot it wrote is the created account's — not this row's, which
        // may still say "WSL default". Found by diffing the roster rather than
        // by the row's active id, which resolves to null once two distro slots
        // are filled and would send the notice to the wrong lane.
        const newAccounts =
          action === 'adding'
            ? next.accounts.filter(
                (account) => !codexAccounts.accounts.some((prior) => prior.id === account.id)
              )
            : []
        // Why exactly one: an unloaded prior roster makes every account look new,
        // and picking one of those would aim the notice at an unrelated lane.
        // Falling back to the row is the pre-existing behaviour, not a new risk.
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
          // Why: two accounts can share an email, so the labels alone cannot
          // tell the store whether this switch lands back on the launch account.
          previousAccountId: previousActiveAccountId ?? null,
          nextAccountId: nextActiveAccountId ?? null,
          // Why: the mutation wrote this row's slot only, so panes on any other
          // lane still launch under the account they already had.
          target: addedAccount ? getProviderAccountRuntime(addedAccount) : actionRuntime,
          // Why: clearing a distro-less WSL row nulls every distro slot at once.
          clearsEveryWslDistro: action === 'select:system'
        })
      }
    } catch (error) {
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
  settings: GlobalSettings
  accountRuntime: LocalAccountRuntime
  isRemoteAccountScope: boolean
  claudeAccounts: ClaudeRateLimitAccountsState
  setClaudeAccounts: Dispatch<SetStateAction<ClaudeRateLimitAccountsState>>
  setClaudeAction: Dispatch<SetStateAction<ClaudeAccountAction>>
  fetchSettings: () => Promise<void>
  recordFeatureInteraction: (featureId: FeatureInteractionId) => void
}

export function createClaudeAccountActionRunner(
  context: ClaudeActionContext
): ClaudeAccountActionRunner {
  const {
    accountRuntime,
    claudeAccounts,
    fetchSettings,
    isRemoteAccountScope,
    recordFeatureInteraction,
    setClaudeAccounts,
    setClaudeAction
  } = context
  const syncClaudeAccounts = async (next: ClaudeRateLimitAccountsState): Promise<void> => {
    setClaudeAccounts(next)
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
      const shouldPromptRestart =
        action === 'adding' ||
        previousActiveAccountId !== nextActiveAccountId ||
        (action.startsWith('reauth:') &&
          nextActiveAccountId !== null &&
          action === `reauth:${nextActiveAccountId}`)
      if (shouldPromptRestart) {
        toast.info(
          translate('auto.components.settings.AccountsPane.f921d32606', 'Claude account updated.'),
          {
            description: translate(
              'auto.components.settings.AccountsPane.b15ce90870',
              '{{value0}} -> {{value1}}. Restart live Claude terminals before continuing old sessions.',
              {
                value0: getClaudeAccountLabel(claudeAccounts, previousActiveAccountId),
                value1: getClaudeAccountLabel(next, nextActiveAccountId)
              }
            )
          }
        )
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
