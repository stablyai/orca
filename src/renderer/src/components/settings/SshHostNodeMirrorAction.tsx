import type { SshManagedServerStatus } from '../../../../shared/ssh-types'
import { useAppStore } from '@/store'
import { nodeMirrorRecoveryLabel } from '@/ssh/ssh-host-node-download-copy'
import {
  openNodeMirrorRecovery,
  thisComputerNodeMirrorRecovery
} from '@/ssh/node-dist-mirror-recovery'
import { Button } from '../ui/button'

export function SshHostNodeMirrorAction({
  targetId,
  status,
  ownerEnvironmentId = null
}: {
  targetId: string
  status: SshManagedServerStatus | undefined
  ownerEnvironmentId?: string | null
}): React.JSX.Element | null {
  const configuredMirror = useAppStore((s) => s.settings?.nodeDistMirrorUrl)
  const recovery = thisComputerNodeMirrorRecovery(status, ownerEnvironmentId, configuredMirror)
  if (!recovery) {
    return null
  }
  return (
    <Button
      type="button"
      size="xs"
      variant="outline"
      onClick={() => openNodeMirrorRecovery(targetId, recovery)}
    >
      {nodeMirrorRecoveryLabel(recovery)}
    </Button>
  )
}
