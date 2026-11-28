import { useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { useTranslate } from '@/i18n/use-translate'
import { AccountSwitchSessionTree } from './AccountSwitchSessionTree'
import type {
  AccountSwitchPrompt,
  AccountSwitchPromptAnswer
} from '@/lib/provider-accounts/account-switch-prompt'
import type { AccountSwitchCopy } from '@/lib/provider-accounts/account-switch-copy'

/** Asks, after an account switch, which terminals still running the agent on the old account restart. */
export default function AccountSwitchPromptDialog({
  prompt,
  copy,
  onAnswer
}: {
  prompt: AccountSwitchPrompt
  copy: AccountSwitchCopy
  onAnswer: AccountSwitchPromptAnswer
}): React.JSX.Element {
  const t = useTranslate()
  const [dontAskAgain, setDontAskAgain] = useState(false)
  const { onAccount, elsewhere, cantMove } = prompt.sessions
  // Only sessions on the outgoing account start ticked.
  const [ticked, setTicked] = useState<ReadonlySet<string>>(
    () => new Set(onAccount.map((session) => session.ptyId))
  )
  const listedCount = onAccount.length + elsewhere.length + cantMove.length
  const chosen = [...onAccount, ...elsewhere]
    .map((session) => session.ptyId)
    .filter((ptyId) => ticked.has(ptyId))
  const toggle = (ptyId: string, checked: boolean): void => {
    setTicked((current) => {
      const next = new Set(current)
      if (checked) {
        next.add(ptyId)
      } else {
        next.delete(ptyId)
      }
      return next
    })
  }
  const description = prompt.review
    ? copy.reviewBody(elsewhere.length + cantMove.length, prompt.nextAccountLabel)
    : copy.body({
        count: onAccount.length,
        fresh: onAccount.filter((session) => session.reason).length,
        previous: prompt.previousAccountLabel,
        next: prompt.nextAccountLabel
      })
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        // Closing keeps sessions as-is without undoing the account switch.
        if (!open) {
          onAnswer('keep', { dontAskAgain })
        }
      }}
    >
      <DialogContent
        data-session-list={listedCount > 1}
        className="sm:max-w-md sm:data-[session-list=true]:max-w-lg"
        showCloseButton={false}
      >
        <DialogHeader>
          <DialogTitle>
            {t('accounts.claude.switchSessions.title', 'Switched to {{account}}', {
              account: prompt.nextAccountLabel
            })}
          </DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {(listedCount > 1 || prompt.review) && (
          <AccountSwitchSessionTree
            copy={copy}
            sessions={prompt.sessions}
            previousAccountLabel={prompt.previousAccountLabel}
            selected={ticked}
            onToggle={toggle}
          />
        )}
        {/* Why hidden on review: restarting automatically is already the setting. */}
        {!prompt.review && (
          <label className="flex min-w-0 items-start gap-2.5">
            <Checkbox
              checked={dontAskAgain}
              onCheckedChange={(checked) => setDontAskAgain(checked === true)}
              className="mt-0.5"
            />
            <span className="min-w-0 space-y-0.5">
              <span className="block text-sm">
                {t(
                  'accounts.claude.switchSessions.dontAskAgain',
                  "Don't ask again (restart automatically)"
                )}
              </span>
              <span className="block text-xs text-muted-foreground">
                {t(
                  'accounts.claude.switchSessions.dontAskAgainHint',
                  'You can turn this off in Settings → AI Provider Accounts.'
                )}
              </span>
            </span>
          </label>
        )}
        <DialogFooter className="sm:justify-between">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => onAnswer('keep', { dontAskAgain })}
          >
            {t('accounts.claude.switchSessions.keep', 'Keep as is')}
          </Button>
          <Button
            type="button"
            size="sm"
            autoFocus
            disabled={chosen.length === 0}
            onClick={() => onAnswer('restart', { ptyIds: chosen, dontAskAgain })}
          >
            <RefreshCw className="size-3.5" aria-hidden="true" />
            {chosen.length <= 1
              ? t('accounts.claude.switchSessions.restartOne', 'Restart session')
              : t('accounts.claude.switchSessions.restartCount', 'Restart {{count}} sessions', {
                  count: chosen.length,
                  defaultValue_one: 'Restart {{count}} session'
                })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
