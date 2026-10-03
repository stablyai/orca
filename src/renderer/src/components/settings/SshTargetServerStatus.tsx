import type { SshTarget } from '../../../../shared/ssh-types'
import { cn } from '@/lib/utils'
import { useAppStore } from '@/store'
import { sshHostServerStatusLine } from './ssh-host-server-status-copy'
import { SshHostChangedActions } from './SshHostChangedActions'

/** Which server this SSH host runs: its managed Orca server, or the relay and why. */
export function SshTargetServerStatus({
  target,
  onChanged
}: {
  target: SshTarget
  onChanged: () => void
}): React.JSX.Element | null {
  const state = useAppStore((s) => s.sshConnectionStates.get(target.id))
  const line = sshHostServerStatusLine(target, state)
  if (!line) {
    return null
  }
  return (
    <div className="space-y-1">
      <p
        className={cn(
          'px-1 text-xs',
          line.tone === 'muted' && 'text-muted-foreground',
          line.tone === 'warning' && 'text-status-warning',
          line.tone === 'destructive' && 'text-destructive'
        )}
      >
        {line.text}
      </p>
      <SshHostChangedActions target={target} onChanged={onChanged} />
    </div>
  )
}
