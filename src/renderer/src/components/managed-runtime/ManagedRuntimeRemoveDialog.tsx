import { useAppStateValue } from '@/store/retained-views/app-state-view'
import { useTranslate } from '@/i18n/use-translate'
import { selectExecutionHostDisplayLabel } from '@/lib/execution-host-display-label'
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

export function ManagedRuntimeRemoveDialog(props: {
  agentLabel: string
  host: RuntimeClientTarget
  open: boolean
  onOpenChange: (open: boolean) => void
  onRemove: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const { agentLabel, host, open, onOpenChange, onRemove } = props
  const hostLabel = useAppStateValue((state) =>
    host.kind === 'environment'
      ? selectExecutionHostDisplayLabel(state, toRuntimeExecutionHostId(host.environmentId))
      : t('components.managed-runtime.thisComputer', 'this computer')
  )
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {t(
              'components.managed-runtime.removeTitle',
              'Remove the downloaded {{agent}} runtime from {{host}}?',
              { agent: agentLabel, host: hostLabel }
            )}
          </DialogTitle>
          <DialogDescription>
            {t(
              'components.managed-runtime.removeDescription',
              '{{agent}} chats that are running stop. Their history is kept.',
              { agent: agentLabel }
            )}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('components.managed-runtime.removeKeep', 'Cancel')}
          </Button>
          <Button
            variant="destructive"
            onClick={() => {
              onOpenChange(false)
              onRemove()
            }}
          >
            {t('components.managed-runtime.removeConfirm', 'Remove')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
