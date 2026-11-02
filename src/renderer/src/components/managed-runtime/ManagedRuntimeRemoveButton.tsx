import { useState } from 'react'
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
import { ManagedRuntimeLinkButton } from './ManagedRuntimeLinkButton'

/** Settings' Remove link for the runtime Orca downloaded, behind a confirmation: it stops running
 *  chats. */
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
  return (
    <>
      <ManagedRuntimeLinkButton
        disabled={disabled}
        aria-label={translate('components.managed-runtime.remove', 'Remove downloaded runtime')}
        onClick={() => setConfirming(true)}
      >
        {translate('components.managed-runtime.removeConfirm', 'Remove')}
      </ManagedRuntimeLinkButton>
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
                '{{agent}} chats that are running stop. Their history is kept.',
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
