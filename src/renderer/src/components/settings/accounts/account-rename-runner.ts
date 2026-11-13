import type { Dispatch, SetStateAction } from 'react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import type {
  ClaudeRateLimitAccountsState,
  CodexRateLimitAccountsState
} from '../../../../../shared/managed-account-types'
import type { RuntimeClientTarget } from '../../../../../shared/runtime-client-target'
import {
  renameClaudeProviderAccount,
  renameCodexProviderAccount
} from '@/runtime/provider-accounts/observations/runtime-provider-accounts-client'
import {
  getClaudeAccountErrorDescription,
  getCodexAccountErrorDescription
} from '../../../lib/provider-accounts/provider-account-action-errors'
import type { RenameAccountTarget } from './accounts-pane-types'

export function renamingAccountKey(target: Pick<RenameAccountTarget, 'provider' | 'id'>): string {
  return `${target.provider}:${target.id}`
}

export function withRenamedAccount<
  State extends { accounts: readonly { id: string; displayName?: string }[] }
>(
  current: State,
  reply: { accounts: readonly { id: string; displayName?: string }[] },
  accountId: string
): State {
  const displayName = reply.accounts.find((account) => account.id === accountId)?.displayName
  if (!current.accounts.some((account) => account.id === accountId)) {
    return current
  }
  return {
    ...current,
    accounts: current.accounts.map((account) => {
      if (account.id !== accountId) {
        return account
      }
      const { displayName: _previous, ...rest } = account
      return displayName ? { ...rest, displayName } : rest
    })
  }
}

type AccountRenameContext = {
  accountOwner: RuntimeClientTarget
  hostLabel: string
  isCurrentAccountOwner: () => boolean
  isRemoteAccountScope: boolean
  setClaudeAccounts: Dispatch<SetStateAction<ClaudeRateLimitAccountsState>>
  setCodexAccounts: Dispatch<SetStateAction<CodexRateLimitAccountsState>>
  fetchSettings: () => Promise<void>
  setRenamingAccountKeys: Dispatch<SetStateAction<ReadonlySet<string>>>
}

/** Renames keep their own pending state so a sign-in, select or remove in flight stays busy. */
export function createAccountRenameRunner(
  context: AccountRenameContext
): (target: RenameAccountTarget, displayName: string) => Promise<void> {
  const { accountOwner, hostLabel, isCurrentAccountOwner, setRenamingAccountKeys } = context
  const setPending = (key: string, pending: boolean): void =>
    setRenamingAccountKeys((previous) => {
      const next = new Set(previous)
      if (pending) {
        next.add(key)
      } else {
        next.delete(key)
      }
      return next
    })
  return async (target, displayName) => {
    const key = renamingAccountKey(target)
    const rename = { accountId: target.id, displayName }
    setPending(key, true)
    try {
      const reply =
        target.provider === 'claude'
          ? await renameClaudeProviderAccount(accountOwner, rename, hostLabel)
          : await renameCodexProviderAccount(accountOwner, rename, hostLabel)
      // Local names live in this desktop's settings; read them first so the pane's
      // settings overlay already holds the new name when the row updates.
      if (!context.isRemoteAccountScope) {
        await context.fetchSettings()
      }
      // Apply only this account's name: a select or remove may have answered after the
      // host built this reply, and its whole roster would undo that newer state.
      if (isCurrentAccountOwner()) {
        if (target.provider === 'claude') {
          context.setClaudeAccounts((current) => withRenamedAccount(current, reply, target.id))
        } else {
          context.setCodexAccounts((current) => withRenamedAccount(current, reply, target.id))
        }
      }
    } catch (error) {
      if (target.provider === 'claude') {
        toast.error(
          translate(
            'auto.components.settings.AccountsPane.2743cdc0af',
            'Claude account update failed.'
          ),
          { description: getClaudeAccountErrorDescription(error) }
        )
      } else {
        toast.error(
          translate(
            'auto.components.settings.AccountsPane.5bf8764953',
            'Codex account update failed.'
          ),
          { description: getCodexAccountErrorDescription(error) }
        )
      }
    } finally {
      setPending(key, false)
    }
  }
}
