import { useEffect, useEffectEvent, useId, useState } from 'react'
import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import {
  measureClaudeRetainedHistory,
  removeClaudeProviderAccount
} from '@/runtime/provider-accounts/observations/claude-account-removal-client'
import { getProviderAccountsOwnerKey } from '@/runtime/provider-accounts/observations/runtime-provider-accounts-client'
import { Button } from '../../../ui/button'
import { Checkbox } from '../../../ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '../../../ui/dialog'
import { Label } from '../../../ui/label'
import type { AccountsPaneSectionModel, RemoveAccountTarget } from '../accounts-pane-types'
import { formatBytes } from '../../../../../../shared/text/format-bytes'
import { getManagedAccountInlineLabel } from '../../../../../../shared/agent-accounts/managed-account-display-names'
import { hasRuntimeRpcErrorCode } from '../../../../../../shared/remote-runtime/rpc/runtime-rpc-error-code'

type ClaudeRemovalModel = Pick<
  AccountsPaneSectionModel,
  | 'accountOwner'
  | 'accountRuntimeSentenceLabel'
  | 'setRemoveClaudeTarget'
  | 'runClaudeAccountAction'
> & {
  claudeAccounts: { accounts: readonly { id: string; email: string; displayName?: string }[] }
}

type RetainedHistory =
  | { status: 'measuring' }
  | { status: 'measured'; bytes: number }
  | { status: 'failed' }
  /** The host's Orca predates keeping them, so removal deletes them there. */
  | { status: 'deletedByHost' }

function useClaudeRetainedHistory(
  model: ClaudeRemovalModel,
  accountId: string
): { history: RetainedHistory; retry: () => void } {
  const [attempt, setAttempt] = useState(0)
  const [history, setHistory] = useState<RetainedHistory>({ status: 'measuring' })
  const measure = useEffectEvent((signal: AbortSignal) => {
    measureClaudeRetainedHistory(model.accountOwner, accountId).then(
      ({ bytes }) => !signal.aborted && setHistory({ status: 'measured', bytes }),
      (error: unknown) =>
        !signal.aborted &&
        setHistory({
          status: hasRuntimeRpcErrorCode(error, 'method_not_found') ? 'deletedByHost' : 'failed'
        })
    )
  })
  useEffect(() => {
    const controller = new AbortController()
    measure(controller.signal)
    return () => controller.abort()
  }, [accountId, attempt])
  return {
    history,
    retry: () => {
      setHistory({ status: 'measuring' })
      setAttempt((value) => value + 1)
    }
  }
}

function RetainedHistoryChoice({
  history,
  deleteHistory,
  onDeleteHistoryChange,
  onRetry,
  host,
  t
}: {
  history: RetainedHistory
  deleteHistory: boolean
  onDeleteHistoryChange: (value: boolean) => void
  onRetry: () => void
  host: string
  t: Translate
}): React.JSX.Element {
  const checkboxId = useId()
  // Tall enough for every state's text (the two-line failure included) so the dialog never moves.
  const slot =
    'flex min-h-15 items-start gap-2 rounded-md border border-border/70 px-3 py-2 text-sm'
  if (history.status === 'failed') {
    return (
      <div className={`${slot} items-center justify-between`}>
        <span className="text-muted-foreground">
          {t(
            'settings.accounts.claudeRemoveHistoryMeasureFailed',
            "Couldn't check the conversations kept only for this account. They stay unless you delete them."
          )}
        </span>
        <Button variant="outline" size="xs" onClick={onRetry}>
          {t('settings.accounts.claudeRemoveHistoryRetry', 'Try again')}
        </Button>
      </div>
    )
  }
  if (history.status === 'deletedByHost') {
    return (
      <div className={slot}>
        <span className="text-muted-foreground">
          {t(
            'settings.accounts.claudeRemoveHistoryDeletedByHost',
            'Orca on {{host}} also deletes the conversations kept only for this account. Update Orca there to keep them.',
            { host }
          )}
        </span>
      </div>
    )
  }
  if (history.status === 'measured' && history.bytes === 0) {
    return (
      <div className={slot}>
        <span className="text-muted-foreground">
          {t(
            'settings.accounts.claudeRemoveHistoryNone',
            'No conversations are kept only for this account.'
          )}
        </span>
      </div>
    )
  }
  return (
    <div className={slot}>
      <Checkbox
        id={checkboxId}
        checked={deleteHistory}
        disabled={history.status !== 'measured'}
        onCheckedChange={(checked) => onDeleteHistoryChange(checked === true)}
        aria-describedby={`${checkboxId}-size`}
        className="mt-0.5"
      />
      <span className="min-w-0 flex-1">
        <Label htmlFor={checkboxId} className="cursor-pointer">
          {t(
            'settings.accounts.claudeRemoveHistoryDelete',
            'Also delete conversations kept only for this account'
          )}
        </Label>
        <span id={`${checkboxId}-size`} className="mt-1 block text-xs text-muted-foreground">
          {history.status === 'measured' ? formatBytes(history.bytes) : ' '}
        </span>
      </span>
    </div>
  )
}

function ClaudeAccountRemovalContent({
  model,
  target,
  accountLabel,
  t
}: {
  model: ClaudeRemovalModel
  target: RemoveAccountTarget
  accountLabel: string
  t: Translate
}): React.JSX.Element {
  const { history, retry } = useClaudeRetainedHistory(model, target.id)
  const [deleteHistory, setDeleteHistory] = useState(false)
  const deletes = deleteHistory && history.status === 'measured' && history.bytes > 0
  return (
    <>
      <DialogHeader>
        <DialogTitle>
          {t('auto.components.settings.AccountsPane.63843e37e2', 'Remove Claude Account?')}
        </DialogTitle>
        <DialogDescription>
          <span className="block font-medium text-foreground">{accountLabel}</span>
          {t(
            'settings.accounts.claudeRemoveSignIn',
            "Orca removes this account's sign-in and settings on {{host}}. Your System default login and chat history shared with it stay. If it is selected, the next Claude you start uses System default.",
            { host: model.accountRuntimeSentenceLabel }
          )}
        </DialogDescription>
      </DialogHeader>
      <RetainedHistoryChoice
        history={history}
        deleteHistory={deleteHistory}
        onDeleteHistoryChange={setDeleteHistory}
        onRetry={retry}
        host={model.accountRuntimeSentenceLabel}
        t={t}
      />
      <DialogFooter>
        <Button variant="outline" onClick={() => model.setRemoveClaudeTarget(null)}>
          {t('auto.components.settings.AccountsPane.dbb9626ed1', 'Cancel')}
        </Button>
        <Button
          variant="destructive"
          onClick={() => {
            model.setRemoveClaudeTarget(null)
            void model.runClaudeAccountAction(
              `remove:${target.id}`,
              () =>
                removeClaudeProviderAccount(
                  model.accountOwner,
                  target.id,
                  {
                    deleteRetainedHistory: deletes,
                    hostDeletesHistory: history.status === 'deletedByHost'
                  },
                  model.accountRuntimeSentenceLabel
                ),
              target.runtime
            )
          }}
        >
          {deletes
            ? t('settings.accounts.claudeRemoveWithHistory', 'Remove account and conversations')
            : t('auto.components.settings.AccountsPane.699680a328', 'Remove account')}
        </Button>
      </DialogFooter>
    </>
  )
}

export function ClaudeAccountRemovalDialog({
  model,
  target,
  t = translate
}: {
  model: ClaudeRemovalModel
  target: RemoveAccountTarget | null
  t?: Translate
}): React.JSX.Element {
  // Each open starts over (keep, fresh size); the last target stays rendered while closing.
  const [shown, setShown] = useState({ target, generation: 0 })
  if (target && target !== shown.target) {
    setShown({ target, generation: shown.generation + 1 })
  }
  const content = target ?? shown.target
  const account = model.claudeAccounts.accounts.find((entry) => entry.id === content?.id)
  return (
    <Dialog
      open={target !== null}
      onOpenChange={(open) => !open && model.setRemoveClaudeTarget(null)}
    >
      <DialogContent showCloseButton={false}>
        {content ? (
          <ClaudeAccountRemovalContent
            // A different host's account can share the id: start over when the owner changes.
            key={`${shown.generation}:${getProviderAccountsOwnerKey(model.accountOwner)}`}
            model={model}
            target={content}
            accountLabel={account ? getManagedAccountInlineLabel(account) : ''}
            t={t}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  )
}
