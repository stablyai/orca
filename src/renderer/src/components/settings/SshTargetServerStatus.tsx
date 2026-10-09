import { ArrowRightLeft, ChevronDown } from 'lucide-react'
import { useState } from 'react'
import type { SshTarget } from '../../../../shared/ssh-types'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import { canMoveSshHostToManagedServer } from '@/ssh/ssh-managed-server-move'
import { useAppStore } from '@/store'
import { Button } from '../ui/button'
import { SshManagedServerMoveDialog } from './SshManagedServerMoveDialog'
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
  const [moveOpen, setMoveOpen] = useState(false)
  const line = sshHostServerStatusLine(target, state)
  const status = state?.managedServer
  const terminals = status?.kind === 'relay' ? status.terminals : undefined
  const canMove = line?.action === 'move' && canMoveSshHostToManagedServer()
  // Why moveOpen too: a move publishes setting-up, which drops the action; the open dialog must
  // stay mounted to show its outcome and keep Move disabled.
  const moveDialog =
    canMove || moveOpen ? (
      <SshManagedServerMoveDialog
        open={moveOpen}
        targetId={target.id}
        host={target.label}
        terminals={terminals}
        onClose={() => setMoveOpen(false)}
      />
    ) : null
  if (!line) {
    return moveDialog
  }
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-2">
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
        {canMove ? (
          <Button type="button" size="xs" variant="ghost" onClick={() => setMoveOpen(true)}>
            <ArrowRightLeft />
            {translate('auto.ssh.managedServerMove.title', 'Move to managed server')}
          </Button>
        ) : null}
      </div>
      {line.detail ? (
        <Collapsible>
          <CollapsibleTrigger asChild>
            <Button type="button" variant="ghost" size="xs" className="group">
              {translate('auto.components.settings.sshHostServer.failureDetails', 'Details')}
              <ChevronDown className="transition-transform group-data-[state=open]:rotate-180" />
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <pre className="scrollbar-sleek max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-background px-3 py-2 font-mono text-[11px] leading-relaxed text-muted-foreground">
              {line.detail}
            </pre>
          </CollapsibleContent>
        </Collapsible>
      ) : null}
      <SshHostChangedActions target={target} onChanged={onChanged} />
      {moveDialog}
    </div>
  )
}
