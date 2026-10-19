import { translate } from '@/i18n/i18n'
import { selectExecutionHostDisplayLabel } from '@/lib/execution-host-display-label'
import { useAppStore } from '@/store'
import { toRuntimeExecutionHostId } from '../../../../shared/execution-host'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { Button } from '../ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '../ui/dialog'

/** Confirms removing the runtime Orca downloaded: it stops running chats. */
export function ManagedRuntimeRemoveDialog(props: {
  agentLabel: string
  host: RuntimeClientTarget
  open: boolean
  onOpenChange: (open: boolean) => void
  onRemove: () => void
}): React.JSX.Element {
  const { agentLabel, host, open, onOpenChange, onRemove } = props
  const hostLabel = useAppStore((state) =>
    host.kind === 'environment'
      ? selectExecutionHostDisplayLabel(state, toRuntimeExecutionHostId(host.environmentId))
      : translate('components.managed-runtime.thisComputer', 'this computer')
  )
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {translate(
              'components.managed-runtime.removeTitle',
              'Remove the downloaded {{agent}} runtime from {{host}}?',
              { agent: agentLabel, host: hostLabel }
            )}
          </DialogTitle>
          <DialogDescription>
            {translate(
              'components.managed-runtime.removeDescription',
              '{{agent}} chats that are running stop. Their history is kept.',
              { agent: agentLabel }
            )}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {translate('components.managed-runtime.removeKeep', 'Cancel')}
          </Button>
          <Button
            variant="destructive"
            onClick={() => {
              onOpenChange(false)
              onRemove()
            }}
          >
            {translate('components.managed-runtime.removeConfirm', 'Remove')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
