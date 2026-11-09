import { useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../ui/dialog'
import {
  CloudAgentSetupSavedNotice,
  CloudAgentSetupView,
  type CloudAgentSetupSaved
} from './CloudAgentSetupView'
import { useCloudAgentSetup } from './use-cloud-agent-setup'

function DialogBody({
  onClose,
  onSaved,
  escapeGuardRef
}: {
  onClose: () => void
  onSaved?: () => void
  escapeGuardRef: React.Ref<() => boolean>
}): React.JSX.Element {
  const t = useTranslate()
  const { model, save } = useCloudAgentSetup({ repo: null })
  const [saved, setSaved] = useState<CloudAgentSetupSaved | null>(null)
  if (saved) {
    return <CloudAgentSetupSavedNotice saved={saved} onClose={onClose} />
  }
  if (model.status === 'loading') {
    return (
      <div className="flex h-40 items-center justify-center" aria-busy="true">
        <Loader2 aria-hidden className="size-4 animate-spin text-muted-foreground" />
        <span className="sr-only">
          {t('cloudAgentSetup.loading', 'Checking what agents can use…')}
        </span>
      </div>
    )
  }
  return (
    <CloudAgentSetupView
      readiness={model.readiness}
      canShare={model.canShare}
      steadyHeight
      escapeGuardRef={escapeGuardRef}
      onSave={save}
      onSaved={(next) => {
        setSaved(next)
        onSaved?.()
      }}
      onCancel={onClose}
    />
  )
}

/** Settings' way back into "Add an agent" after the first-workspace step was used or skipped. */
export function CloudAgentSetupDialog({
  open,
  onOpenChange,
  onSaved
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSaved?: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const [visit, setVisit] = useState(0)
  const [wasOpen, setWasOpen] = useState(open)
  const escapeGuard = useRef<(() => boolean) | null>(null)
  // A fresh body per visit (fresh readiness, empty form) that stays mounted through the close animation.
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) {
      setVisit((value) => value + 1)
    }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-xl"
        onEscapeKeyDown={(event) => {
          // Asks before discarding a typed key; a second Escape (or Discard) closes.
          if (escapeGuard.current?.()) {
            event.preventDefault()
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>{t('cloudAgentSetup.title', 'Add an agent')}</DialogTitle>
          <DialogDescription>
            {t(
              'cloudAgentSetup.subtitle',
              'Choose how Claude Code or Codex gets access in your Orca Cloud workspaces.'
            )}
          </DialogDescription>
        </DialogHeader>
        <DialogBody
          key={visit}
          onClose={() => onOpenChange(false)}
          onSaved={onSaved}
          escapeGuardRef={escapeGuard}
        />
      </DialogContent>
    </Dialog>
  )
}
