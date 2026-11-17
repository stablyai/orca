import { useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter
} from '@/components/ui/dialog'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Label } from '@/components/ui/label'
import { useTranslate } from '@/i18n/use-translate'
import { useHistoryResumeChoice } from './history-resume-choice'
import type { HistoryResumePlan } from '../../../../../../shared/ai-vault/resume/history-resume-accounts'

export function HistoryResumeAccountDialogHost() {
  const request = useHistoryResumeChoice((state) => state.request)
  return request ? (
    <HistoryResumeAccountDialog
      key={request.plan.token}
      plan={request.plan}
      onSelect={request.settle}
    />
  ) : null
}

export function HistoryResumeAccountDialog({
  plan,
  onSelect
}: {
  plan: HistoryResumePlan
  onSelect: (value: string | null | undefined) => void
}) {
  const t = useTranslate()
  const preferred =
    plan.lastAccountId !== undefined &&
    plan.accounts.some((a) => a.id === plan.lastAccountId && a.available)
      ? plan.lastAccountId
      : plan.accounts.some((a) => a.id === plan.workspaceAccountId && a.available)
        ? plan.workspaceAccountId
        : undefined
  const [selected, setSelected] = useState(
    preferred === undefined ? '' : preferred === null ? 'system' : preferred
  )
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) {
          onSelect(undefined)
        }
      }}
    >
      <DialogContent>
        <div className="scrollbar-sleek grid max-h-[calc(100dvh-5rem)] gap-4 overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {t('historyResume.chooseTitle', 'Which account should continue this conversation?')}
            </DialogTitle>
            <DialogDescription>
              {plan.lastAccountId === undefined
                ? t(
                    'historyResume.unknownLast',
                    'Orca has not recorded the account last used for this session. Choose an account for this continuation.'
                  )
                : !plan.accounts.some(
                      (account) => account.id === plan.lastAccountId && account.available
                    )
                  ? t(
                      'historyResume.lastUnavailable',
                      'The account last used is unavailable. Choose another account or sign in again in Settings.'
                    )
                  : t(
                      'historyResume.differentWorkspace',
                      'The workspace account differs from the account last used. This choice applies only to this continuation.'
                    )}
            </DialogDescription>
          </DialogHeader>
          <RadioGroup value={selected} onValueChange={setSelected}>
            {plan.accounts.map((account) => {
              const value = account.id ?? 'system'
              return (
                <div
                  key={value}
                  className="flex items-start gap-3 rounded-md border border-border p-3"
                >
                  <RadioGroupItem
                    value={value}
                    id={`resume-account-${value}`}
                    disabled={!account.available}
                  />
                  <div className="min-w-0">
                    <Label className="break-all" htmlFor={`resume-account-${value}`}>
                      {account.label}
                    </Label>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {!account.available
                        ? t(
                            'historyResume.unavailable',
                            'Unavailable on this host or needs sign-in'
                          )
                        : plan.lastAccountId !== undefined && account.id === plan.lastAccountId
                          ? t('historyResume.lastUsed', 'Last used for this session')
                          : plan.workspaceAccountId !== undefined &&
                              account.id === plan.workspaceAccountId
                            ? t('historyResume.workspaceAccount', 'Workspace account')
                            : ''}
                    </p>
                  </div>
                </div>
              )
            })}
          </RadioGroup>
          <p className="text-xs text-muted-foreground">
            {t(
              'historyResume.copyHint',
              'Using another account creates an independent continuation. The original conversation is preserved.'
            )}
          </p>
          <DialogFooter>
            <Button variant="ghost" onClick={() => onSelect(undefined)}>
              {t('historyResume.cancel', 'Cancel')}
            </Button>
            <Button
              disabled={
                !plan.accounts.some(
                  (account) => (account.id ?? 'system') === selected && account.available
                )
              }
              onClick={() => onSelect(selected === 'system' ? null : selected)}
            >
              {t('historyResume.continue', 'Continue')}
            </Button>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  )
}
