import type { SshManagedServerStatus } from '../../../../shared/ssh-types'
import { isSshHostMoveBlocked } from '../../../../shared/ssh-host-move-blocked'
import { translate } from '@/i18n/i18n'
import { Button } from '@/components/ui/button'
import { showPlainSshPanel } from '@/ssh/plain-ssh-terminal-panels'

/** Offer escape-hatch terminals only for blocked hosts this desktop can dial; paired-server hosts are that server’s responsibility. */
export function OpenPlainSshTerminalButton({
  targetId,
  targetLabel,
  status,
  ownerEnvironmentId = null
}: {
  targetId: string
  targetLabel: string
  status: SshManagedServerStatus | undefined
  ownerEnvironmentId?: string | null
}): React.JSX.Element | null {
  if (ownerEnvironmentId || !isSshHostMoveBlocked(status) || !window.api.plainSsh) {
    return null
  }
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <Button
        type="button"
        size="xs"
        variant="outline"
        onClick={() => showPlainSshPanel(targetId, targetLabel)}
      >
        {translate('auto.components.plainSshTerminal.open', 'Open plain SSH terminal')}
      </Button>
      <span className="text-xs text-muted-foreground">
        {translate(
          'auto.components.plainSshTerminal.openHint',
          'Keeps you working on the host while Orca can’t set up there.'
        )}
      </span>
    </span>
  )
}
