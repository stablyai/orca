import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { translate } from '@/i18n/i18n'

type BrowserToolbarProfileDialogsProps = {
  pendingSwitchProfileId: string | null | undefined
  onPendingSwitchChange: (open: boolean) => void
  onConfirmSwitch: () => void
  newProfileDialogOpen: boolean
  onNewProfileDialogOpenChange: (open: boolean) => void
  newProfileName: string
  onNewProfileNameChange: (value: string) => void
  isCreatingProfile: boolean
  onCreateProfile: () => void
  onCancelNewProfile: () => void
}

export function BrowserToolbarProfileDialogs({
  pendingSwitchProfileId,
  onPendingSwitchChange,
  onConfirmSwitch,
  newProfileDialogOpen,
  onNewProfileDialogOpenChange,
  newProfileName,
  onNewProfileNameChange,
  isCreatingProfile,
  onCreateProfile,
  onCancelNewProfile
}: BrowserToolbarProfileDialogsProps): React.JSX.Element {
  return (
    <>
      <Dialog
        open={pendingSwitchProfileId !== undefined}
        onOpenChange={(open) => {
          if (!open) {
            onPendingSwitchChange(false)
          }
        }}
      >
        <DialogContent className="sm:max-w-sm" showCloseButton={false}>
          <DialogHeader>
            <DialogTitle className="text-base">
              {translate(
                'auto.components.browser.pane.BrowserToolbarMenu.fe683eb3b4',
                'Switch Profile'
              )}
            </DialogTitle>
            <DialogDescription className="text-xs">
              {translate(
                'auto.components.browser.pane.BrowserToolbarMenu.a38f217b46',
                'Switching profiles will reload this page. Any unsaved form data will be lost.'
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => onPendingSwitchChange(false)}>
              {translate('auto.components.browser.pane.BrowserToolbarMenu.429ef481f9', 'Cancel')}
            </Button>
            <Button size="sm" onClick={onConfirmSwitch}>
              {translate('auto.components.browser.pane.BrowserToolbarMenu.58f2c81542', 'Switch')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={newProfileDialogOpen} onOpenChange={onNewProfileDialogOpenChange}>
        <DialogContent className="sm:max-w-sm" showCloseButton={false}>
          <DialogHeader>
            <DialogTitle className="text-base">
              {translate(
                'auto.components.browser.pane.BrowserToolbarMenu.67e9b9fcd6',
                'New Browser Profile'
              )}
            </DialogTitle>
          </DialogHeader>
          <form
            onSubmit={(e) => {
              e.preventDefault()
              onCreateProfile()
            }}
          >
            <Input
              value={newProfileName}
              onChange={(e) => onNewProfileNameChange(e.target.value)}
              placeholder={translate(
                'auto.components.browser.pane.BrowserToolbarMenu.64f448fb6e',
                'Profile name'
              )}
              autoFocus
              maxLength={50}
              className="mb-4"
            />
            <DialogFooter>
              <Button type="button" variant="outline" size="sm" onClick={onCancelNewProfile}>
                {translate('auto.components.browser.pane.BrowserToolbarMenu.429ef481f9', 'Cancel')}
              </Button>
              <Button
                type="submit"
                size="sm"
                disabled={!newProfileName.trim() || isCreatingProfile}
              >
                {isCreatingProfile
                  ? translate(
                      'auto.components.browser.pane.BrowserToolbarMenu.bf648471c5',
                      'Creating…'
                    )
                  : translate(
                      'auto.components.browser.pane.BrowserToolbarMenu.569bce8eb1',
                      'Create'
                    )}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  )
}
