import { useState } from 'react'
import { KeyRound } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { translate } from '@/i18n/i18n'
import type {
  BrowserPasswordSavePrompt,
  BrowserPasswordSavePromptAction
} from '../../../../../shared/browser-passwords-types'
import {
  clearBrowserPasswordSavePrompt,
  useBrowserPasswordPageState
} from './browser-password-page-store'

function hostOf(origin: string): string {
  try {
    return new URL(origin).host
  } catch {
    return origin
  }
}

/** Key icon beside the address bar, opening Orca's offer to save or update a login that worked. */
export function BrowserPasswordSaveButton({
  browserPageId,
  isActive
}: {
  browserPageId: string
  isActive: boolean
}): React.JSX.Element | null {
  const { savePrompt } = useBrowserPasswordPageState(browserPageId)
  // Why keyed: each offer starts open with its own username, without syncing props into state.
  return isActive && savePrompt ? (
    <BrowserPasswordSavePopover
      key={savePrompt.promptId}
      browserPageId={browserPageId}
      savePrompt={savePrompt}
    />
  ) : null
}

function BrowserPasswordSavePopover({
  browserPageId,
  savePrompt
}: {
  browserPageId: string
  savePrompt: BrowserPasswordSavePrompt
}): React.JSX.Element {
  // Opens on arrival: the offer belongs to the login the user just finished.
  const [open, setOpen] = useState(true)
  const [username, setUsername] = useState(savePrompt.username)

  const respond = (action: BrowserPasswordSavePromptAction): void => {
    clearBrowserPasswordSavePrompt(browserPageId)
    void window.api.browserPasswords.respondSavePrompt({
      promptId: savePrompt.promptId,
      action,
      username
    })
  }
  const host = hostOf(savePrompt.origin)
  const isUpdate = savePrompt.mode === 'update'

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="h-7 w-7 shrink-0"
          aria-label={translate('browser.passwords.savePrompt.open', 'Saved password offer')}
        >
          <KeyRound className="size-4" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        side="bottom"
        sideOffset={6}
        className="w-80"
        // Why: the offer opens by itself after a page load; typing on that page must stay there.
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        <div className="space-y-3 p-3">
          <div className="space-y-1">
            <div className="text-sm font-medium text-foreground">
              {isUpdate
                ? translate('browser.passwords.savePrompt.updateTitle', 'Update password?')
                : translate('browser.passwords.savePrompt.saveTitle', 'Save password?')}
            </div>
            <div className="truncate text-xs text-muted-foreground">{host}</div>
          </div>
          <div className="space-y-2">
            <div className="space-y-1">
              <Label htmlFor={`browser-password-save-${savePrompt.promptId}`}>
                {translate('browser.passwords.savePrompt.username', 'Username')}
              </Label>
              <Input
                id={`browser-password-save-${savePrompt.promptId}`}
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                disabled={isUpdate}
              />
            </div>
            <div className="space-y-1">
              <div className="text-sm leading-none font-medium text-foreground">
                {translate('browser.passwords.savePrompt.password', 'Password')}
              </div>
              <div className="font-mono text-sm text-muted-foreground" aria-hidden>
                ••••••••
              </div>
            </div>
          </div>
          <div className="flex items-center justify-between gap-2">
            {isUpdate ? (
              <span />
            ) : (
              <Button type="button" variant="ghost" size="xs" onClick={() => respond('never')}>
                {translate('browser.passwords.savePrompt.never', 'Never for this site')}
              </Button>
            )}
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="secondary"
                size="xs"
                onClick={() => respond('dismiss')}
              >
                {translate('browser.passwords.savePrompt.notNow', 'Not now')}
              </Button>
              <Button type="button" size="xs" onClick={() => respond('save')}>
                {isUpdate
                  ? translate('browser.passwords.savePrompt.update', 'Update')
                  : translate('browser.passwords.savePrompt.save', 'Save')}
              </Button>
            </div>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}
