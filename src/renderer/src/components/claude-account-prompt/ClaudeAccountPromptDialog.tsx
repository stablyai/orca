import { useEffect, useId, useState, useSyncExternalStore } from 'react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { claudeAccountLabel } from '../settings/repository-claude-account'
import {
  answerClaudeAccountPrompt,
  getClaudeAccountPromptRequest,
  subscribeClaudeAccountPrompt,
  type ClaudeAccountPromptRequest
} from './claude-account-prompt-state'

function initialAccountId(request: ClaudeAccountPromptRequest | null): string {
  if (!request) {
    return ''
  }
  const active = request.accounts.find((account) => account.id === request.activeAccountId)
  return (active ?? request.accounts[0])?.id ?? ''
}

export default function ClaudeAccountPromptDialog(): React.JSX.Element {
  const request = useSyncExternalStore(
    subscribeClaudeAccountPrompt,
    getClaudeAccountPromptRequest,
    getClaudeAccountPromptRequest
  )
  const activeModal = useAppStore((state) => state.activeModal)
  const setContextualToursBlockingSurfaceVisible = useAppStore(
    (state) => state.setContextualToursBlockingSurfaceVisible
  )
  const [accountId, setAccountId] = useState(() => initialAccountId(request))
  const [remember, setRemember] = useState(true)
  // Why: keeps the last request rendered while the dialog animates closed.
  const [displayed, setDisplayed] = useState(request)
  const selectLabelId = useId()
  const rememberId = useId()
  // Why: New Workspace awaits this prompt while its composer modal stays open, so it layers on top
  // like the composer's other nested dialogs instead of waiting for a modal that never closes.
  const open =
    request !== null && (activeModal === 'none' || activeModal === 'new-workspace-composer')

  if (request && request !== displayed) {
    setDisplayed(request)
    setAccountId(initialAccountId(request))
    setRemember(true)
  }

  useEffect(() => {
    setContextualToursBlockingSurfaceVisible(open)
    return () => setContextualToursBlockingSurfaceVisible(false)
  }, [open, setContextualToursBlockingSurfaceVisible])

  return (
    <Dialog
      open={open}
      onOpenChange={(isOpen) => {
        if (!isOpen) {
          answerClaudeAccountPrompt({ kind: 'cancelled' })
        }
      }}
    >
      <DialogContent className="sm:max-w-md" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>
            {translate(
              'auto.components.ClaudeAccountPromptDialog.title',
              'Choose a Claude account'
            )}
          </DialogTitle>
          <DialogDescription>
            {translate(
              'auto.components.ClaudeAccountPromptDialog.description',
              'Pick the Claude account to start in {{value0}}.',
              { value0: displayed?.projectName ?? '' }
            )}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <span id={selectLabelId} className="text-xs text-muted-foreground">
              {translate('auto.components.ClaudeAccountPromptDialog.accountLabel', 'Account')}
            </span>
            <Select value={accountId} onValueChange={setAccountId}>
              <SelectTrigger size="sm" className="w-full" aria-labelledby={selectLabelId}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(displayed?.accounts ?? []).map((account) => (
                  <SelectItem key={account.id} value={account.id}>
                    {claudeAccountLabel(account)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <Checkbox
                id={rememberId}
                checked={remember}
                onCheckedChange={(checked) => setRemember(checked === true)}
              />
              <Label htmlFor={rememberId}>
                {translate(
                  'auto.components.ClaudeAccountPromptDialog.remember',
                  'Remember for this project'
                )}
              </Label>
            </div>
            <p className="pl-6 text-xs text-muted-foreground">
              {translate(
                'auto.components.ClaudeAccountPromptDialog.rememberHint',
                'You can change this in Settings → Repository'
              )}
            </p>
          </div>
        </div>
        <DialogFooter>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => answerClaudeAccountPrompt({ kind: 'cancelled' })}
          >
            {translate('auto.components.ClaudeAccountPromptDialog.cancel', 'Cancel')}
          </Button>
          <Button
            type="button"
            size="sm"
            autoFocus
            disabled={!accountId}
            onClick={() => answerClaudeAccountPrompt({ kind: 'start', accountId, remember })}
          >
            {translate('auto.components.ClaudeAccountPromptDialog.start', 'Start')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
