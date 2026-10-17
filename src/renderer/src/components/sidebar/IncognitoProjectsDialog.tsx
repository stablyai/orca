import React, { useEffect, useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import type { IncognitoUnlockResult } from '../../../../shared/incognito-projects'

const MIN_PASSCODE_LENGTH = 4

function describeFailure(result: IncognitoUnlockResult): string | null {
  if (result.ok) {
    return null
  }
  switch (result.reason) {
    case 'wrong-passcode':
      return translate('incognitoProjects.wrongPasscode', 'That passcode is not correct.')
    case 'rate-limited':
      return translate(
        'incognitoProjects.rateLimited',
        'Too many attempts. Try again in {{seconds}} seconds.',
        { seconds: Math.ceil((result.retryAfterMs ?? 0) / 1000) }
      )
    case 'invalid-passcode':
      return translate('incognitoProjects.passcodeTooShort', 'Use at least {{count}} characters.', {
        count: MIN_PASSCODE_LENGTH
      })
    case 'cancelled':
      return null
    case 'locked':
    case 'unavailable':
      return translate('incognitoProjects.unlockUnavailable', 'Could not unlock on this device.')
  }
}

const IncognitoProjectsDialog = React.memo(function IncognitoProjectsDialog() {
  const dialog = useAppStore((s) => s.incognitoProjectsDialog)
  const closeDialog = useAppStore((s) => s.closeIncognitoProjectsDialog)
  const completeSetup = useAppStore((s) => s.completeIncognitoProjectsSetup)
  const [passcode, setPasscode] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const isSetup = dialog?.kind === 'setup'

  useEffect(() => {
    // Why: never keep a typed passcode in memory after the dialog closes or switches mode.
    setPasscode('')
    setConfirmation('')
    setError(null)
  }, [dialog])

  const submit = async (): Promise<void> => {
    if (busy) {
      return
    }
    if (isSetup && passcode !== confirmation) {
      setError(translate('incognitoProjects.passcodeMismatch', 'The passcodes do not match.'))
      return
    }
    setBusy(true)
    try {
      const result = isSetup
        ? await window.api.incognitoProjects.setPasscode({ passcode })
        : await window.api.incognitoProjects.unlockWithPasscode({ passcode })
      if (!result.ok) {
        setError(describeFailure(result))
        return
      }
      if (isSetup) {
        await completeSetup()
      } else {
        closeDialog()
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={dialog !== null} onOpenChange={(open) => !open && closeDialog()}>
      <DialogContent className="sm:max-w-sm">
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault()
            void submit()
          }}
        >
          <DialogHeader>
            <DialogTitle>
              {isSetup
                ? translate('incognitoProjects.setupTitle', 'Set an incognito passcode')
                : translate('incognitoProjects.unlockTitle', 'Show incognito projects')}
            </DialogTitle>
            <DialogDescription>
              {isSetup
                ? translate(
                    'incognitoProjects.setupDescription',
                    'Incognito projects stay hidden until this passcode is entered. Orca stores only a hash of it. Hiding is not encryption: files on disk are unchanged.'
                  )
                : translate(
                    'incognitoProjects.unlockDescription',
                    'Enter your incognito passcode. Projects hide again when Orca restarts or the screen locks.'
                  )}
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            <Label htmlFor="incognito-passcode">
              {translate('incognitoProjects.passcodeLabel', 'Passcode')}
            </Label>
            <Input
              id="incognito-passcode"
              type="password"
              autoComplete={isSetup ? 'new-password' : 'current-password'}
              autoFocus
              value={passcode}
              onChange={(event) => {
                setPasscode(event.target.value)
                setError(null)
              }}
            />
            {isSetup ? (
              <>
                <Label htmlFor="incognito-passcode-confirm">
                  {translate('incognitoProjects.confirmPasscodeLabel', 'Confirm passcode')}
                </Label>
                <Input
                  id="incognito-passcode-confirm"
                  type="password"
                  autoComplete="new-password"
                  value={confirmation}
                  onChange={(event) => {
                    setConfirmation(event.target.value)
                    setError(null)
                  }}
                />
              </>
            ) : null}
            {error ? (
              <p role="alert" className="text-xs text-destructive">
                {error}
              </p>
            ) : null}
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={closeDialog}>
              {translate('incognitoProjects.cancel', 'Cancel')}
            </Button>
            <Button type="submit" disabled={busy || passcode.length < MIN_PASSCODE_LENGTH}>
              {isSetup
                ? translate('incognitoProjects.setPasscode', 'Set passcode')
                : translate('incognitoProjects.unlock', 'Unlock')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
})

export default IncognitoProjectsDialog
