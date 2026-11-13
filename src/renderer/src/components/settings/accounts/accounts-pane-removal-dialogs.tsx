import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import {
  removeClaudeProviderAccount,
  removeCodexProviderAccount
} from '@/runtime/provider-accounts/observations/runtime-provider-accounts-client'
import { Button } from '../../ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '../../ui/dialog'
import type { AccountsPaneSectionModel, RemoveAccountTarget } from './accounts-pane-types'
import { getManagedAccountInlineLabel } from '../../../../../shared/managed-account-display-names'

function removalAccountLabel(
  accounts: readonly { id: string; email: string; displayName?: string }[],
  target: RemoveAccountTarget | null
): string {
  const account = target ? accounts.find((entry) => entry.id === target.id) : undefined
  return account ? getManagedAccountInlineLabel(account) : ''
}

export function renderAccountsRemovalDialogs(
  model: AccountsPaneSectionModel,
  removeCodexTarget: RemoveAccountTarget | null,
  removeClaudeTarget: RemoveAccountTarget | null,
  t: Translate = translate
): React.JSX.Element {
  const {
    runClaudeAccountAction,
    runCodexAccountAction,
    setRemoveClaudeTarget,
    setRemoveCodexTarget,
    accountOwner,
    accountRuntimeSentenceLabel,
    claudeAccounts,
    codexAccounts
  } = model
  return (
    <>
      <Dialog
        open={removeCodexTarget !== null}
        onOpenChange={(open) => !open && setRemoveCodexTarget(null)}
      >
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>
              {t('auto.components.settings.AccountsPane.0d47394635', 'Remove Codex Account?')}
            </DialogTitle>
            <DialogDescription>
              <span className="block font-medium text-foreground">
                {removalAccountLabel(codexAccounts.accounts, removeCodexTarget)}
              </span>
              {t(
                'settings.accounts.codexRemoveHome',
                "Orca deletes this account's Codex folder on {{host}}, including its sign-in, MCP logins and any Codex history stored only in that folder. This cannot be undone. If it is selected, the next Codex you start uses System default.",
                { host: accountRuntimeSentenceLabel }
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRemoveCodexTarget(null)}>
              {t('auto.components.settings.AccountsPane.dbb9626ed1', 'Cancel')}
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                const target = removeCodexTarget
                if (!target) {
                  return
                }
                setRemoveCodexTarget(null)
                void runCodexAccountAction(
                  `remove:${target.id}`,
                  () => removeCodexProviderAccount(accountOwner, target.id),
                  target.runtime
                )
              }}
            >
              {t('auto.components.settings.AccountsPane.699680a328', 'Remove account')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={removeClaudeTarget !== null}
        onOpenChange={(open) => !open && setRemoveClaudeTarget(null)}
      >
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>
              {t('auto.components.settings.AccountsPane.63843e37e2', 'Remove Claude Account?')}
            </DialogTitle>
            <DialogDescription>
              <span className="block font-medium text-foreground">
                {removalAccountLabel(claudeAccounts.accounts, removeClaudeTarget)}
              </span>
              {t(
                'settings.accounts.claudeRemoveProfile',
                "Orca deletes this account's own Claude folder and the sign-in saved in it on {{host}}. Your System default login and chat history shared with it stay. If it is selected, the next Claude you start uses System default.",
                { host: accountRuntimeSentenceLabel }
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRemoveClaudeTarget(null)}>
              {t('auto.components.settings.AccountsPane.dbb9626ed1', 'Cancel')}
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                const target = removeClaudeTarget
                if (!target) {
                  return
                }
                setRemoveClaudeTarget(null)
                void runClaudeAccountAction(
                  `remove:${target.id}`,
                  () => removeClaudeProviderAccount(accountOwner, target.id),
                  target.runtime
                )
              }}
            >
              {t('auto.components.settings.AccountsPane.699680a328', 'Remove account')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
