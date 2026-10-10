import { translate } from '@/i18n/i18n'
import {
  removeClaudeProviderAccount,
  removeCodexProviderAccount
} from '@/runtime/runtime-provider-accounts-client'
import { Button } from '../ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '../ui/dialog'
import type { AccountsPaneSectionModel, RemoveAccountTarget } from './accounts-pane-types'

export function renderAccountsRemovalDialogs(
  model: AccountsPaneSectionModel,
  removeCodexTarget: RemoveAccountTarget | null,
  removeClaudeTarget: RemoveAccountTarget | null
): React.JSX.Element {
  const {
    runClaudeAccountAction,
    runCodexAccountAction,
    setRemoveClaudeTarget,
    setRemoveCodexTarget,
    settings
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
              {translate(
                'auto.components.settings.AccountsPane.0d47394635',
                'Remove Codex Account?'
              )}
            </DialogTitle>
            <DialogDescription>
              {translate(
                'auto.components.settings.AccountsPane.380a7736cc',
                'Removing this account permanently deletes its managed Codex home, including all Codex session history and MCP logins stored inside. This cannot be undone. If the account is currently active, Orca falls back to the system default Codex login.'
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRemoveCodexTarget(null)}>
              {translate('auto.components.settings.AccountsPane.dbb9626ed1', 'Cancel')}
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
                  () => removeCodexProviderAccount(settings, target.id),
                  target.runtime
                )
              }}
            >
              {translate('auto.components.settings.AccountsPane.c2d2751587', 'Remove Account')}
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
              {translate(
                'auto.components.settings.AccountsPane.63843e37e2',
                'Remove Claude Account?'
              )}
            </DialogTitle>
            <DialogDescription>
              {translate(
                'settings.accounts.claudeRemoveFolder',
                "Orca deletes this account's Claude folder and its sign-in from this computer. Chat history shared with System default stays. If it is selected, the next Claude you start uses System default."
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRemoveClaudeTarget(null)}>
              {translate('auto.components.settings.AccountsPane.dbb9626ed1', 'Cancel')}
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
                  () => removeClaudeProviderAccount(settings, target.id),
                  target.runtime
                )
              }}
            >
              {translate('auto.components.settings.AccountsPane.c2d2751587', 'Remove Account')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
