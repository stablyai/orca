import { useState } from 'react'
import { KeyRound } from 'lucide-react'
import { useAppStore } from '@/store'
import { useTranslate } from '@/i18n/use-translate'
import { Button } from '../ui/button'
import { isCloudAgentReady } from './cloud-agent-readiness'
import { CloudAgentSetupDialog } from './CloudAgentSetupDialog'
import { useCloudAgentSetup } from './use-cloud-agent-setup'

export function ComposerCloudAgentHintView({
  onSetUp,
  onLater
}: {
  onSetUp: () => void
  onLater: () => void
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <div
      role="status"
      className="flex items-center gap-2.5 rounded-md border border-border/70 bg-muted/35 px-3 py-2"
      data-composer-cloud-agent-hint=""
    >
      <KeyRound aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
      <p className="min-w-0 flex-1 text-xs text-muted-foreground">
        {t(
          'cloudAgentSetup.composerHint',
          'Claude Code and Codex need access in Orca Cloud. Add it now, or sign in once the workspace starts.'
        )}
      </p>
      <Button type="button" variant="outline" size="xs" onClick={onSetUp}>
        {t('cloudAgentSetup.title', 'Add an agent')}
      </Button>
      <Button type="button" variant="ghost" size="xs" onClick={onLater}>
        {t('cloudAgentSetup.later', 'Later')}
      </Button>
    </div>
  )
}

/**
 * "Add an agent" the moment Orca Cloud is picked for the first time, before anything is created, so a
 * warm sandbox that starts in seconds cannot outrun it. Quiet once agents are covered or it was handled.
 */
export function ComposerCloudAgentHint(): React.JSX.Element | null {
  const done = useAppStore((s) => s.cloudAgentSetupDone)
  const markDone = useAppStore((s) => s.markCloudAgentSetupDone)
  const [open, setOpen] = useState(false)
  const { model } = useCloudAgentSetup({ repo: null, enabled: !done })
  if (done || model.status === 'loading' || isCloudAgentReady(model.readiness)) {
    return null
  }
  return (
    <>
      <ComposerCloudAgentHintView onSetUp={() => setOpen(true)} onLater={markDone} />
      <CloudAgentSetupDialog open={open} onOpenChange={setOpen} onSaved={markDone} />
    </>
  )
}
