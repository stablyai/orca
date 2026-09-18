import { useState } from 'react'
import { Loader2, Play } from 'lucide-react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { useMountedRef } from '@/hooks/useMountedRef'
import type { EphemeralVmRuntimeRecord } from '../../../../shared/ephemeral-vm-runtimes'
import { Button } from '../ui/button'

type Props = {
  runtime: EphemeralVmRuntimeRecord
  disabled: boolean
  onResumed: () => void
  onResumingChange: (value: boolean) => void
}

export function EphemeralVmResumeButton({
  runtime,
  disabled,
  onResumed,
  onResumingChange
}: Props): React.JSX.Element | null {
  const [resuming, setResuming] = useState(false)
  const mountedRef = useMountedRef()
  const reconnecting = runtime.status === 'running' && Boolean(runtime.runtimeEnvironmentId)
  if (
    !runtime.workspaceId ||
    (!reconnecting && !['suspended', 'resume_failed'].includes(runtime.status))
  ) {
    return null
  }
  const resume = async (): Promise<void> => {
    setResuming(true)
    onResumingChange(true)
    try {
      const { resumeEphemeralVmWorkspace } = await import('@/lib/ephemeral-vm-workspace-resume')
      await resumeEphemeralVmWorkspace(runtime.workspaceId!)
    } catch (error) {
      if (mountedRef.current) {
        toast.error(
          error instanceof Error
            ? error.message
            : translate(
                'auto.components.settings.EphemeralVmResumeButton.failed',
                'Could not resume Cloud VM.'
              )
        )
      }
    } finally {
      if (mountedRef.current) {
        onResumed()
        setResuming(false)
        onResumingChange(false)
      }
    }
  }
  return (
    <Button
      type="button"
      variant="ghost"
      size="xs"
      className="gap-1.5 text-muted-foreground hover:text-foreground"
      disabled={disabled || resuming}
      onClick={() => void resume()}
    >
      {resuming ? <Loader2 className="size-3 animate-spin" /> : <Play className="size-3" />}
      {resuming
        ? translate('auto.components.settings.EphemeralVmResumeButton.resuming', 'Resuming…')
        : reconnecting
          ? translate('auto.components.settings.EphemeralVmResumeButton.reconnect', 'Reconnect')
          : translate('auto.components.settings.EphemeralVmResumeButton.resume', 'Resume')}
    </Button>
  )
}
