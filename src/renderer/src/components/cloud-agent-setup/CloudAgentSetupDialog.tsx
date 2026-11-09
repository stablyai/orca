import { Loader2 } from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../ui/dialog'
import { CloudAgentSetupView } from './CloudAgentSetupView'
import { useCloudAgentSetup } from './use-cloud-agent-setup'

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
  const { model, save } = useCloudAgentSetup({ repo: null, enabled: open })
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{t('cloudAgentSetup.title', 'Add an agent')}</DialogTitle>
          <DialogDescription className="sr-only">
            {t(
              'cloudAgentSetup.subtitle',
              'Choose how Claude Code or Codex gets access in your Orca Cloud workspaces.'
            )}
          </DialogDescription>
        </DialogHeader>
        {model.status === 'loading' ? (
          <div className="flex h-40 items-center justify-center" aria-busy="true">
            <Loader2 className="size-4 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <CloudAgentSetupView
            readiness={model.readiness}
            canShare={model.canShare}
            surface="dialog"
            onSave={async (choice, scope) => {
              const failure = await save(choice, scope)
              if (!failure) {
                onSaved?.()
              }
              return failure
            }}
            onLater={() => onOpenChange(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}
