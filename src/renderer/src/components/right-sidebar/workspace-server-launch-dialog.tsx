import React, { useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { translate } from '@/i18n/i18n'
import type { WorkspacePort } from '../../../../shared/workspace-ports'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import {
  getWorkspaceServerLaunches,
  saveWorkspaceServerLaunch,
  removeWorkspaceServerLaunch,
  workspaceServerLaunchKey
} from '@/lib/workspace-server-launches'

export function WorkspaceServerLaunchDialog({
  port,
  runtimeTarget,
  executionHostId,
  onClose,
  canRemove = true
}: {
  port: WorkspacePort & { kind: 'workspace' }
  runtimeTarget: RuntimeClientTarget
  executionHostId: string
  canRemove?: boolean
  onClose: () => void
}): React.JSX.Element {
  const id = workspaceServerLaunchKey(
    runtimeTarget,
    executionHostId,
    port.owner.worktreeId,
    port.port
  )
  const existing = getWorkspaceServerLaunches().find((entry) => entry.id === id)
  const [name, setName] = useState(
    existing?.name ?? `${port.processName ?? 'Server'} :${port.port}`
  )
  const [command, setCommand] = useState(existing?.command ?? '')
  const [cwd, setCwd] = useState(existing?.cwd ?? port.owner.path)
  const [error, setError] = useState('')
  const save = () => {
    try {
      saveWorkspaceServerLaunch({
        id,
        runtimeTarget,
        executionHostId,
        worktreeId: port.owner.worktreeId,
        repoId: port.owner.repoId,
        workspacePath: port.owner.path,
        name: name.trim(),
        port: port.port,
        command: command.trim(),
        cwd: cwd.trim(),
        sourcePtyId: port.sourcePtyId ?? existing?.sourcePtyId
      })
      onClose()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) {
          onClose()
        }
      }}
    >
      <DialogContent surface="security">
        <DialogHeader>
          <DialogTitle>
            {translate(
              'auto.components.right.sidebar.index.serverCommand',
              'Server Startup Command'
            )}
          </DialogTitle>
          <DialogDescription>
            {translate(
              'auto.components.right.sidebar.index.serverCommandDescription',
              'Save a command to run this server in the background. Its logs and errors appear in Servers.'
            )}
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault()
            save()
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="server-launch-name">
              {translate('auto.components.right.sidebar.index.serverName', 'Name')}
            </Label>
            <Input
              id="server-launch-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              required
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="server-launch-command">
              {translate('auto.components.right.sidebar.index.serverCommandField', 'Command')}
            </Label>
            <Textarea
              id="server-launch-command"
              value={command}
              onChange={(event) => setCommand(event.target.value)}
              maxLength={16384}
              className="font-mono"
              placeholder="pnpm dev --port 4008"
              required
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="server-launch-cwd">
              {translate(
                'auto.components.right.sidebar.index.serverDirectory',
                'Working Directory'
              )}
            </Label>
            <Input
              id="server-launch-cwd"
              value={cwd}
              onChange={(event) => setCwd(event.target.value)}
              className="font-mono"
              required
            />
          </div>
          {error && (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            {existing && (
              <Button
                type="button"
                variant="outline"
                disabled={!canRemove}
                onClick={() => {
                  try {
                    removeWorkspaceServerLaunch(id)
                    onClose()
                  } catch (cause) {
                    setError(String(cause))
                  }
                }}
              >
                {translate(
                  'auto.components.right.sidebar.index.forgetServerCommand',
                  'Forget Command'
                )}
              </Button>
            )}
            <Button type="button" variant="ghost" onClick={onClose}>
              {translate('auto.components.right.sidebar.index.cancelServerCommand', 'Cancel')}
            </Button>
            <Button type="submit" disabled={!name.trim() || !command.trim() || !cwd.trim()}>
              {translate('auto.components.right.sidebar.index.saveServerCommand', 'Save Command')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
