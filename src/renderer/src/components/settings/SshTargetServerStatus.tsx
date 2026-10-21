import type { SshConnectionState, SshTarget } from '../../../../shared/ssh-types'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import { DropdownMenuItem, DropdownMenuSeparator } from '../ui/dropdown-menu'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../ui/dialog'
import { sshHostServerStatusLine } from '@/ssh/ssh-host-server-status-copy'
import {
  hasSshHostSourceChanged,
  SshHostKeepServerVersionDialog
} from './SshHostKeepServerVersionDialog'
import { SshHostDeltaMoveDialog } from './SshHostDeltaMoveDialog'
import { SshHostNodeMirrorAction } from './SshHostNodeMirrorAction'
import { canMoveSshHostAnyway, SshHostMoveAnywayDialog } from './SshHostMoveAnywayAction'
import { canRestartSshHostServer, SshHostRestartServerDialog } from './SshHostRestartServerAction'
import { getManagedOrcadApi } from './use-managed-server-catalog'

export type SshTargetServerDialog =
  | 'details'
  | 'delta-move'
  | 'keep-server'
  | 'restart'
  | 'move-anyway'

/** Whether Orca on this SSH host serves it, and why not when it doesn't. */
export function SshTargetServerStatusLine({
  target,
  state
}: {
  target: SshTarget
  state: SshConnectionState | undefined
}): React.JSX.Element | null {
  const line = sshHostServerStatusLine(target, state)
  if (!line) {
    return null
  }
  return (
    <div className="mt-0.5 flex flex-wrap items-center gap-2">
      <p
        className={cn(
          'text-xs',
          line.tone === 'muted' && 'text-muted-foreground',
          line.tone === 'warning' && 'text-status-warning',
          line.tone === 'destructive' && 'text-destructive'
        )}
      >
        {line.text}
      </p>
      {line.hint ? <p className="px-1 text-xs text-muted-foreground">{line.hint}</p> : null}
      {/* Why inline, not in the menu: it is the way out of this failure. */}
      <SshHostNodeMirrorAction targetId={target.id} status={state?.managedServer} />
    </div>
  )
}

/** The managed-server actions this host offers right now, as row-menu entries. */
export function SshTargetServerMenuItems({
  target,
  state,
  onOpenDialog
}: {
  target: SshTarget
  state: SshConnectionState | undefined
  onOpenDialog: (dialog: SshTargetServerDialog) => void
}): React.JSX.Element | null {
  const status = state?.managedServer
  const hasDetail = Boolean(sshHostServerStatusLine(target, state)?.detail)
  const sourceChanged = hasSshHostSourceChanged(target)
  const canRestart = canRestartSshHostServer(status)
  const canMoveAnyway = canMoveSshHostAnyway(status)
  if (!hasDetail && !sourceChanged && !canRestart && !canMoveAnyway) {
    return null
  }
  return (
    <>
      <DropdownMenuSeparator />
      {sourceChanged ? (
        <>
          <DropdownMenuItem onSelect={() => onOpenDialog('delta-move')}>
            {translate('auto.components.settings.deltaMove.action', 'Move the new projects…')}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => onOpenDialog('keep-server')}>
            {translate('auto.components.settings.keepServer.action', 'Keep the server’s version…')}
          </DropdownMenuItem>
        </>
      ) : null}
      {canRestart ? (
        <DropdownMenuItem onSelect={() => onOpenDialog('restart')}>
          {translate('auto.components.settings.restartServer.action', 'Restart Orca’s server…')}
        </DropdownMenuItem>
      ) : null}
      {canMoveAnyway ? (
        <DropdownMenuItem onSelect={() => onOpenDialog('move-anyway')}>
          {translate('auto.components.settings.moveAnyway.action', 'Move anyway…')}
        </DropdownMenuItem>
      ) : null}
      {hasDetail ? (
        <DropdownMenuItem onSelect={() => onOpenDialog('details')}>
          {translate('auto.components.settings.sshHostServer.failureDetails', 'Details')}
        </DropdownMenuItem>
      ) : null}
    </>
  )
}

/** Lives outside the row menu so a dialog outlasts the menu that opened it. */
export function SshTargetServerDialogs({
  target,
  state,
  dialog,
  onDialogChange,
  onChanged
}: {
  target: SshTarget
  state: SshConnectionState | undefined
  dialog: SshTargetServerDialog | null
  onDialogChange: (dialog: SshTargetServerDialog | null) => void
  onChanged: () => void
}): React.JSX.Element {
  const api = getManagedOrcadApi()
  const status = state?.managedServer
  const detail = sshHostServerStatusLine(target, state)?.detail
  const openChange =
    (which: SshTargetServerDialog) =>
    (open: boolean): void =>
      onDialogChange(open ? which : null)
  return (
    <>
      {api ? (
        <SshHostDeltaMoveDialog
          api={api}
          target={dialog === 'delta-move' ? target : null}
          onClose={() => onDialogChange(null)}
          onFinished={onChanged}
        />
      ) : null}
      <SshHostKeepServerVersionDialog
        target={target}
        open={dialog === 'keep-server'}
        onOpenChange={openChange('keep-server')}
        onChanged={onChanged}
      />
      <SshHostRestartServerDialog
        status={status}
        open={dialog === 'restart'}
        onOpenChange={openChange('restart')}
        onChanged={onChanged}
      />
      <SshHostMoveAnywayDialog
        target={target}
        status={status}
        open={dialog === 'move-anyway'}
        onOpenChange={openChange('move-anyway')}
        onChanged={onChanged}
      />
      <Dialog open={dialog === 'details' && Boolean(detail)} onOpenChange={openChange('details')}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              {translate('auto.components.settings.sshHostServer.failureDetails', 'Details')}
            </DialogTitle>
          </DialogHeader>
          <pre className="scrollbar-sleek max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-background px-3 py-2 font-mono text-[11px] leading-relaxed text-muted-foreground">
            {detail}
          </pre>
        </DialogContent>
      </Dialog>
    </>
  )
}
