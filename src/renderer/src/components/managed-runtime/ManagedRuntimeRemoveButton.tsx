import { useState } from 'react'
import { Trash2 } from 'lucide-react'
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
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'

/** Settings' delete of the runtime Orca downloaded, behind a confirmation: it stops running chats. */
export function ManagedRuntimeRemoveButton(props: {
  agentLabel: string
  host: RuntimeClientTarget
  disabled: boolean
  onRemove: () => void
}): React.JSX.Element {
  const { agentLabel, host, disabled, onRemove } = props
  const [confirming, setConfirming] = useState(false)
  const hostLabel = useAppStore((state) =>
    host.kind === 'environment'
      ? selectExecutionHostDisplayLabel(state, toRuntimeExecutionHostId(host.environmentId))
      : translate('components.managed-runtime.thisComputer', 'this computer')
  )
  const label = translate('components.managed-runtime.remove', 'Remove downloaded runtime')
  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            size="icon-xs"
            variant="ghost"
            disabled={disabled}
            aria-label={label}
            onClick={() => setConfirming(true)}
          >
            <Trash2 />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>
      <Dialog open={confirming} onOpenChange={setConfirming}>
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
                'Running {{agent}} chats there stop. Your sign-in and chat history are kept.',
                { agent: agentLabel }
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirming(false)}>
              {translate('components.managed-runtime.removeKeep', 'Cancel')}
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                setConfirming(false)
                onRemove()
              }}
            >
              {translate('components.managed-runtime.removeConfirm', 'Remove')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
