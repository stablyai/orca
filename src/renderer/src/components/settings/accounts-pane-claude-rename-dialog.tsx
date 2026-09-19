import { useEffect, useState, type JSX } from 'react'
import { normalizeClaudeManagedAccountDisplayName } from '../../../../shared/claude-managed-account-label'
import { translate } from '@/i18n/i18n'
import { updateClaudeProviderAccountDisplayName } from '@/runtime/runtime-provider-accounts-client'
import { Button } from '../ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '../ui/dialog'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import type { AccountsPaneSectionModel, RemoveAccountTarget } from './accounts-pane-types'

export function ClaudeAccountRenameDialog({
  model,
  renameClaudeTarget
}: {
  model: AccountsPaneSectionModel
  renameClaudeTarget: RemoveAccountTarget | null
}): JSX.Element {
  const { claudeAccounts, runClaudeAccountAction, setRenameClaudeTarget, settings } = model
  const account = claudeAccounts.accounts.find((entry) => entry.id === renameClaudeTarget?.id)
  const [draft, setDraft] = useState(account?.displayName ?? '')

  useEffect(() => {
    setDraft(account?.displayName ?? '')
  }, [account?.displayName, renameClaudeTarget?.id])

  const close = (): void => setRenameClaudeTarget(null)
  const save = (): void => {
    const target = renameClaudeTarget
    if (!target) {
      return
    }
    const displayName = normalizeClaudeManagedAccountDisplayName(draft)
    close()
    void runClaudeAccountAction(
      `rename:${target.id}`,
      () => updateClaudeProviderAccountDisplayName(settings, target.id, displayName),
      target.runtime
    )
  }

  return (
    <Dialog open={renameClaudeTarget !== null} onOpenChange={(open) => !open && close()}>
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>
            {translate(
              'auto.components.settings.AccountsPane.renameClaudeAccountTitle',
              'Rename Claude account'
            )}
          </DialogTitle>
          <DialogDescription>
            {translate(
              'auto.components.settings.AccountsPane.renameClaudeAccountDescription',
              'This name is only shown in Orca. The account email stays the same.'
            )}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="claude-account-display-name">
            {translate('auto.components.settings.AccountsPane.claudeDisplayName', 'Display name')}
          </Label>
          <Input
            id="claude-account-display-name"
            autoFocus
            value={draft}
            placeholder={account?.email}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                save()
              }
            }}
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={close}>
            {translate('auto.components.settings.AccountsPane.dbb9626ed1', 'Cancel')}
          </Button>
          <Button onClick={save}>
            {translate('auto.components.settings.AccountsPane.590a3130f9', 'Save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
