import React, { useState } from 'react'
import { Play, Square, RotateCw, Pause, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import type { DockerContainerAction, DockerContainerSummary } from '../../../../shared/docker-types'
import { availableActionsForState } from './docker-container-actions'

const ACTION_META: Record<DockerContainerAction, { icon: React.ReactNode }> = {
  start: { icon: <Play /> },
  stop: { icon: <Square /> },
  restart: { icon: <RotateCw /> },
  pause: { icon: <Pause /> },
  unpause: { icon: <Play /> },
  remove: { icon: <Trash2 /> }
}

// Why: literal-key translate calls so the catalog scanner can detect and sync these strings.
function labelForAction(action: DockerContainerAction): string {
  switch (action) {
    case 'start':
      return translate('auto.components.docker.DockerContainerActions.023ec2a235', 'Start')
    case 'stop':
      return translate('auto.components.docker.DockerContainerActions.359f30fd47', 'Stop')
    case 'restart':
      return translate('auto.components.docker.DockerContainerActions.36ac523335', 'Restart')
    case 'pause':
      return translate('auto.components.docker.DockerContainerActions.03e884a128', 'Pause')
    case 'unpause':
      return translate('auto.components.docker.DockerContainerActions.c0c163323f', 'Resume')
    case 'remove':
      return translate('auto.components.docker.DockerContainerActions.bdbc34eec1', 'Remove')
  }
}

export function DockerContainerActions({
  container
}: {
  container: DockerContainerSummary
}): React.JSX.Element {
  const runDockerContainerAction = useAppStore((s) => s.runDockerContainerAction)
  // Why: only the pending flag for this container matters — re-render only when it changes.
  const isPending = useAppStore((s) => s.actionPendingByContainerId[container.id] === true)

  const [removeDialogOpen, setRemoveDialogOpen] = useState(false)

  const containerLabel = container.names[0] ?? container.id.slice(0, 12)

  const run = async (action: DockerContainerAction): Promise<void> => {
    try {
      await runDockerContainerAction(container.id, action)
    } catch (error) {
      toast.error(
        translate(
          'auto.components.docker.DockerContainerActions.174ec8f170',
          'Docker action failed'
        ),
        { description: String(error) }
      )
    }
  }

  const handleRemoveConfirm = async (): Promise<void> => {
    try {
      await runDockerContainerAction(container.id, 'remove')
      setRemoveDialogOpen(false)
    } catch (error) {
      toast.error(
        translate(
          'auto.components.docker.DockerContainerActions.174ec8f170',
          'Docker action failed'
        ),
        { description: String(error) }
      )
      setRemoveDialogOpen(false)
    }
  }

  const actions = availableActionsForState(container.state)

  return (
    <>
      <div className="flex items-center gap-1">
        {actions.map((action) => {
          const meta = ACTION_META[action]
          if (action === 'remove') {
            return (
              <Button
                key="remove"
                variant="destructive"
                size="xs"
                disabled={isPending}
                onClick={() => setRemoveDialogOpen(true)}
              >
                {meta.icon}
                {labelForAction(action)}
              </Button>
            )
          }
          return (
            <Button
              key={action}
              variant="outline"
              size="xs"
              disabled={isPending}
              onClick={() => void run(action)}
            >
              {meta.icon}
              {labelForAction(action)}
            </Button>
          )
        })}
      </div>

      <Dialog open={removeDialogOpen} onOpenChange={setRemoveDialogOpen}>
        <DialogContent className="max-w-sm sm:max-w-sm" showCloseButton={false}>
          <DialogHeader>
            <DialogTitle className="text-sm">
              {translate(
                'auto.components.docker.DockerContainerActions.e3f8420199',
                'Remove container'
              )}
            </DialogTitle>
            <DialogDescription className="text-xs">
              {translate(
                'auto.components.docker.DockerContainerActions.61b45d53bd',
                'Permanently remove {{value0}}? This cannot be undone.',
                { value0: containerLabel }
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setRemoveDialogOpen(false)}
              disabled={isPending}
            >
              {translate(
                'auto.components.docker.DockerContainerActions.b6ca17b955',
                'Cancel'
              )}
            </Button>
            <Button
              variant="destructive"
              disabled={isPending}
              onClick={() => void handleRemoveConfirm()}
            >
              {translate(
                'auto.components.docker.DockerContainerActions.bdbc34eec1',
                'Remove'
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
