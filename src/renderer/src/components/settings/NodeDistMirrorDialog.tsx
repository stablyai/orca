import { useState } from 'react'
import { useAppStore } from '@/store'
import { useMountedRef } from '@/hooks/useMountedRef'
import { translate } from '@/i18n/i18n'
import { nodeDistMirrorRefusalText } from '@/ssh/ssh-host-node-download-copy'
import {
  NODE_DIST_MIRROR_SUGGESTION,
  readNodeDistMirrorDialogTarget,
  saveNodeDistMirrorAndRetry
} from '@/ssh/node-dist-mirror-recovery'
import { toastSshConnectFailure } from '@/ssh/ssh-connect-failure-toast'
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

const INPUT_ID = 'node-dist-mirror-dialog-url'
const HINT_ID = 'node-dist-mirror-dialog-hint'

/** "Use a Node.js mirror" for an SSH host whose setup couldn't download Node on either machine. */
export default function NodeDistMirrorDialog(): React.JSX.Element | null {
  const targetId = useAppStore((s) => readNodeDistMirrorDialogTarget(s.modalData))
  const closeModal = useAppStore((s) => s.closeModal)
  const mountedRef = useMountedRef()
  const [text, setText] = useState(NODE_DIST_MIRROR_SUGGESTION)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // The modal slot has no trigger to restore focus to automatically.
  const [returnFocusTo] = useState(() =>
    document.activeElement instanceof HTMLElement ? document.activeElement : null
  )
  if (!targetId) {
    return null
  }

  const saveAndRetry = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    const result = await saveNodeDistMirrorAndRetry(targetId, text)
    if (result.outcome === 'retrying') {
      // Handle retry rejection even if another modal replaced this one during save.
      result.retry.catch((cause: unknown) =>
        toastSshConnectFailure(
          targetId,
          cause,
          translate(
            'auto.components.settings.nodeDistMirrorDialog.retryFailed',
            'Connection failed'
          )
        )
      )
      if (mountedRef.current) {
        closeModal()
      }
      return
    }
    if (!mountedRef.current) {
      return
    }
    setBusy(false)
    setError(
      result.outcome === 'refused' ? nodeDistMirrorRefusalText(result.reason) : result.message
    )
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && closeModal()}>
      <DialogContent
        surface="security"
        showCloseButton={!busy}
        onCloseAutoFocus={(event) => {
          if (returnFocusTo?.isConnected) {
            event.preventDefault()
            returnFocusTo.focus({ preventScroll: true })
          }
        }}
      >
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault()
            if (!busy) {
              void saveAndRetry()
            }
          }}
        >
          <DialogHeader>
            <DialogTitle>
              {translate(
                'auto.components.settings.nodeDistMirrorDialog.title',
                'Use a Node.js mirror'
              )}
            </DialogTitle>
            <DialogDescription>
              {translate(
                'auto.components.settings.nodeDistMirrorDialog.description',
                'Orca’s server needs Node.js, and neither this computer nor this host could download it from nodejs.org. A mirror is a copy of nodejs.org/dist that Orca tries first on both machines.'
              )}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor={INPUT_ID}>
              {translate('auto.components.settings.nodeDistMirrorDialog.urlLabel', 'Mirror URL')}
            </Label>
            <Input
              id={INPUT_ID}
              value={text}
              onChange={(event) => {
                setText(event.target.value)
                setError(null)
              }}
              autoFocus
              autoCapitalize="none"
              autoCorrect="off"
              autoComplete="off"
              spellCheck={false}
              disabled={busy}
              aria-invalid={error ? true : undefined}
              aria-describedby={HINT_ID}
            />
            {error ? (
              <p id={HINT_ID} role="alert" className="text-xs text-destructive">
                {error}
              </p>
            ) : (
              <p id={HINT_ID} className="text-xs text-muted-foreground">
                {translate(
                  'auto.components.settings.nodeDistMirrorDialog.checksum',
                  'Each download is still checked against the checksum Orca pins for this Node.js release. Saved to Settings > Advanced > Network.'
                )}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={closeModal} disabled={busy}>
              {translate('auto.components.settings.nodeDistMirrorDialog.cancel', 'Cancel')}
            </Button>
            <Button type="submit" disabled={busy}>
              {translate('auto.components.settings.nodeDistMirrorDialog.save', 'Save and retry')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
