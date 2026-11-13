import React, { useState } from 'react'
import { MANAGED_ACCOUNT_DISPLAY_NAME_MAX_LENGTH } from '../../../../../shared/managed-account-display-names'
import {
  renameClaudeProviderAccount,
  renameCodexProviderAccount
} from '@/runtime/provider-accounts/observations/runtime-provider-accounts-client'
import { useTranslate } from '@/i18n/use-translate'
import { Button } from '../../ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '../../ui/dialog'
import { Input } from '../../ui/input'
import { Label } from '../../ui/label'
import type { AccountsPaneSectionModel, RenameAccountTarget } from './accounts-pane-types'

type AccountRenameDialogProps = {
  model: AccountsPaneSectionModel
  target: RenameAccountTarget | null
}

export function AccountRenameDialog({
  model,
  target
}: AccountRenameDialogProps): React.JSX.Element {
  const t = useTranslate()
  const { accountOwner, accountRuntimeSentenceLabel, setRenameTarget } = model
  const [value, setValue] = useState(target?.displayName ?? '')
  // Seed the saved name on every open so a canceled draft cannot reappear.
  const [seededFor, setSeededFor] = useState(target)
  if (seededFor !== target) {
    setSeededFor(target)
    setValue(target?.displayName ?? '')
  }

  const save = (displayName: string | null): void => {
    if (!target) {
      return
    }
    setRenameTarget(null)
    const rename = { accountId: target.id, displayName }
    if (target.provider === 'claude') {
      void model.runClaudeAccountAction(
        `rename:${target.id}`,
        () => renameClaudeProviderAccount(accountOwner, rename, accountRuntimeSentenceLabel),
        target.runtime
      )
    } else {
      void model.runCodexAccountAction(
        `rename:${target.id}`,
        () => renameCodexProviderAccount(accountOwner, rename, accountRuntimeSentenceLabel),
        target.runtime
      )
    }
  }

  return (
    <Dialog open={target !== null} onOpenChange={(open) => !open && setRenameTarget(null)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('accounts.rename.title', 'Rename account')}</DialogTitle>
          <DialogDescription>
            {t(
              'accounts.rename.description',
              'Only the name Orca shows changes. Leave it blank to show {{email}}.',
              { email: target?.email ?? '' }
            )}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="account-rename-input">{t('accounts.rename.label', 'Display name')}</Label>
          <Input
            id="account-rename-input"
            autoFocus
            value={value}
            maxLength={MANAGED_ACCOUNT_DISPLAY_NAME_MAX_LENGTH}
            placeholder={target?.email}
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                save(value)
              }
            }}
          />
        </div>
        <DialogFooter className="sm:justify-between">
          <Button
            type="button"
            variant="ghost"
            disabled={!target?.displayName}
            onClick={() => save(null)}
          >
            {t('accounts.rename.reset', 'Reset to default')}
          </Button>
          <div className="flex gap-2">
            <Button type="button" variant="outline" onClick={() => setRenameTarget(null)}>
              {t('accounts.rename.cancel', 'Cancel')}
            </Button>
            <Button type="button" onClick={() => save(value)}>
              {t('accounts.rename.save', 'Save')}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
