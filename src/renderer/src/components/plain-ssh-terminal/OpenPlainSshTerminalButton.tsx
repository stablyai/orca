import type { SshManagedServerStatus } from '../../../../shared/ssh-types'
import { isSshHostMoveBlocked } from '../../../../shared/ssh-host-move-blocked'
import { translate } from '@/i18n/i18n'
import { Button } from '@/components/ui/button'
import { showPlainSshPanel } from '@/ssh/plain-ssh-terminal-panels'

/**
 * The way to keep working on a host whose move is blocked. Only offered then, and only for a host
 * this desktop dials itself: a remote Orca server's host is that server's to reach.
 */
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
      {/* The next step for any block, including ones retrying can't clear. */}
      <span className="text-xs text-muted-foreground">
        {translate(
          'auto.components.plainSshTerminal.openHint',
          'Keeps you working on the host while Orca can’t set up there.'
        )}
      </span>
    </span>
  )
}
