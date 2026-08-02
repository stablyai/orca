import { useState } from 'react'
import { toast } from 'sonner'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog'
import { useAppStore } from '../../store'
import { useMountedRef } from '@/hooks/useMountedRef'
import { translate } from '@/i18n/i18n'

type BrowserNewProfileDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function BrowserNewProfileDialog({
  open,
  onOpenChange
}: BrowserNewProfileDialogProps): React.JSX.Element {
  const mountedRef = useMountedRef()
  const [newProfileName, setNewProfileName] = useState('')
  const [isCreatingProfile, setIsCreatingProfile] = useState(false)

  const handleClose = (): void => {
    onOpenChange(false)
    setNewProfileName('')
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) {
          handleClose()
        }
      }}
    >
      <DialogContent className="sm:max-w-sm" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle className="text-base">
            {translate('auto.components.settings.BrowserPane.8481ee0331', 'New Browser Profile')}
          </DialogTitle>
        </DialogHeader>
        <form
          onSubmit={async (e) => {
            e.preventDefault()
            const trimmed = newProfileName.trim()
            if (!trimmed) {
              return
            }
            setIsCreatingProfile(true)
            try {
              const profile = await useAppStore
                .getState()
                .createBrowserSessionProfile('isolated', trimmed)
              if (!mountedRef.current) {
                return
              }
              if (profile) {
                handleClose()
                toast.success(
                  translate(
                    'auto.components.settings.BrowserPane.8f22b7580d',
                    'Profile "{{value0}}" created.',
                    { value0: profile.label }
                  )
                )
              } else {
                toast.error(
                  translate(
                    'auto.components.settings.BrowserPane.612f7f6861',
                    'Failed to create profile.'
                  )
                )
              }
            } finally {
              if (mountedRef.current) {
                setIsCreatingProfile(false)
              }
            }
          }}
        >
          <Input
            value={newProfileName}
            onChange={(e) => setNewProfileName(e.target.value)}
            placeholder={translate(
              'auto.components.settings.BrowserPane.7d4c0a2aa4',
              'Profile name'
            )}
            autoFocus
            maxLength={50}
            className="mb-4"
          />
          <DialogFooter>
            <Button type="button" variant="outline" size="sm" onClick={handleClose}>
              {translate('auto.components.settings.BrowserPane.81ff774667', 'Cancel')}
            </Button>
            <Button type="submit" size="sm" disabled={!newProfileName.trim() || isCreatingProfile}>
              {isCreatingProfile
                ? translate('auto.components.settings.BrowserPane.7b649a578a', 'Creating…')
                : translate('auto.components.settings.BrowserPane.64898ecdab', 'Create')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
