import { useSyncExternalStore } from 'react'
import { CircleAlert, Loader2, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import type { ExecutionHostId } from '../../../shared/execution-host'
import {
  readWorkspaceActivationRecoveryPresentation,
  subscribeWorkspaceActivationRecoveryPresentation,
  type WorkspaceActivationRecoveryPresentation
} from '@/lib/workspace-activation-recovery-presentation'

function presentationCopy(presentation: WorkspaceActivationRecoveryPresentation): {
  title: string
  description: string
} {
  if (presentation.kind === 'blocked') {
    return {
      title: translate(
        'auto.components.workspace.activation.recovery.blocked.title',
        'Workspace recovery is paused'
      ),
      description:
        presentation.detail ??
        translate(
          'auto.components.workspace.activation.recovery.blocked.description',
          'Orca could not safely determine whether this workspace already owns a running surface.'
        )
    }
  }
  if (presentation.kind === 'producer-failed') {
    return {
      title: translate(
        'auto.components.workspace.activation.recovery.producerFailed.title',
        'The requested surface did not open'
      ),
      description:
        presentation.detail ??
        translate(
          'auto.components.workspace.activation.recovery.producerFailed.description',
          'The surface producer reported a failure. Retry after correcting the problem.'
        )
    }
  }
  if (presentation.kind === 'unverifiable') {
    return {
      title: translate(
        'auto.components.workspace.activation.recovery.unverifiable.title',
        'Reconnect to continue'
      ),
      description:
        presentation.detail ??
        translate(
          'auto.components.workspace.activation.recovery.unverifiable.description',
          'Orca cannot verify the execution host, so it will not start another process.'
        )
    }
  }
  return {
    title: translate(
      'auto.components.workspace.activation.recovery.unexpected.title',
      'Workspace recovery failed'
    ),
    description:
      presentation.detail ??
      translate(
        'auto.components.workspace.activation.recovery.unexpected.description',
        'An unexpected error interrupted workspace recovery.'
      )
  }
}

export function WorkspaceActivationRecoverySurface({
  worktreeId,
  executionHostId
}: {
  worktreeId: string
  executionHostId: ExecutionHostId
}): React.JSX.Element | null {
  const presentation = useSyncExternalStore(
    subscribeWorkspaceActivationRecoveryPresentation,
    () => readWorkspaceActivationRecoveryPresentation(worktreeId, executionHostId),
    () => null
  )
  if (!presentation) {
    return null
  }
  if (presentation.kind === 'recovering') {
    return (
      <div
        className="absolute inset-0 z-20 flex items-center justify-center bg-background"
        data-workspace-activation-recovery="recovering"
        role="status"
      >
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" aria-hidden="true" />
          {translate(
            'auto.components.workspace.activation.recovery.progress',
            'Checking workspace surfaces…'
          )}
        </div>
      </div>
    )
  }
  const copy = presentationCopy(presentation)
  return (
    <div
      className="absolute inset-0 z-20 flex items-center justify-center bg-background p-6"
      data-workspace-activation-recovery={presentation.kind}
      role="alert"
    >
      <div className="flex w-full max-w-md flex-col items-center text-center">
        <CircleAlert className="size-8 text-destructive" aria-hidden="true" />
        <h2 className="mt-4 text-base font-medium text-foreground">{copy.title}</h2>
        <p className="mt-2 text-sm text-muted-foreground">{copy.description}</p>
        <Button type="button" className="mt-5" onClick={presentation.retry}>
          <RefreshCw className="size-4" aria-hidden="true" />
          {translate('auto.components.workspace.activation.recovery.retry', 'Retry')}
        </Button>
      </div>
    </div>
  )
}
