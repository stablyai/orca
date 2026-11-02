import { useState } from 'react'
import { FolderOpen, Plus } from 'lucide-react'
import { DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { SshConnectionState, SshTarget } from '../../../../shared/ssh-types'
import { RemoteFileBrowser } from './RemoteFileBrowser'
import { SshTargetRow } from './SshTargetRow'
import { AddServerSshHostDialog } from './AddServerSshHostDialog'
import { translate } from '@/i18n/i18n'

type RemoteStepProps = {
  sshTargets: (SshTarget & { state?: SshConnectionState })[]
  selectedTargetId: string | null
  remotePath: string
  remoteError: string | null
  isAddingRemote: boolean
  onSelectTarget: (id: string) => void
  onRemotePathChange: (value: string) => void
  onAdd: () => void
  onConnectTarget: (id: string) => Promise<void>
  /** The paired server whose own SSH hosts are listed. */
  server: {
    environmentId: string
    label: string
    onTargetsChanged: () => void
  }
}

export function RemoteStep({
  sshTargets,
  selectedTargetId,
  remotePath,
  remoteError,
  isAddingRemote,
  onSelectTarget,
  onRemotePathChange,
  onAdd,
  onConnectTarget,
  server
}: RemoteStepProps): React.JSX.Element {
  const [browsing, setBrowsing] = useState(false)
  const [addingServerHost, setAddingServerHost] = useState(false)
  const selectedTarget = selectedTargetId
    ? sshTargets.find((target) => target.id === selectedTargetId)
    : null
  const selectedTargetStatus = selectedTarget?.state?.status ?? 'disconnected'
  const selectedTargetConnected = selectedTargetStatus === 'connected'

  if (browsing && selectedTargetId) {
    return (
      <>
        <DialogHeader>
          <DialogTitle>
            {translate(
              'auto.components.sidebar.AddRepoRemoteStep.dd3ff65486',
              'Browse remote filesystem'
            )}
          </DialogTitle>
          <DialogDescription>
            {translate(
              'auto.components.sidebar.AddRepoRemoteStep.007651bdf9',
              'Navigate to a directory and click Select to choose it.'
            )}
          </DialogDescription>
        </DialogHeader>
        <RemoteFileBrowser
          targetId={selectedTargetId}
          runtimeEnvironmentId={server.environmentId}
          initialPath={remotePath || '~'}
          onSelect={(path) => {
            onRemotePathChange(path)
            setBrowsing(false)
          }}
          onCancel={() => setBrowsing(false)}
        />
      </>
    )
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>
          {translate(
            'auto.components.sidebar.AddRepoRemoteStep.91b93a90a4',
            'Open project on SSH host'
          )}
        </DialogTitle>
        <DialogDescription>
          {translate(
            'auto.components.sidebar.AddRepoRemoteStep.serverDescription',
            'Choose an SSH host that {{server}} connects to, and enter the path to a Git repository on it.',
            { server: server.label }
          )}
        </DialogDescription>
      </DialogHeader>

      <div className="space-y-3 pt-1">
        <div className="space-y-1">
          <label className="text-[11px] font-medium text-muted-foreground">
            {translate('auto.components.sidebar.AddRepoRemoteStep.44637f43bd', 'SSH target')}
          </label>
          {sshTargets.length === 0 ? (
            <p className="py-1 text-xs text-muted-foreground">
              {translate(
                'auto.components.sidebar.AddRepoRemoteStep.serverEmpty',
                '{{server}} has no SSH hosts yet.',
                { server: server.label }
              )}
            </p>
          ) : (
            <div className="space-y-1.5 max-h-64 overflow-y-auto pr-1 scrollbar-sleek">
              {sshTargets.map((target) => (
                <SshTargetRow
                  key={target.id}
                  target={target}
                  isSelected={selectedTargetId === target.id}
                  onSelect={onSelectTarget}
                  onConnect={onConnectTarget}
                />
              ))}
            </div>
          )}
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-xs"
            onClick={() => setAddingServerHost(true)}
          >
            <Plus className="size-3.5" />
            {translate('auto.components.sidebar.AddRepoRemoteStep.serverAddHost', 'Add SSH host')}
          </Button>
          <AddServerSshHostDialog
            environmentId={server.environmentId}
            serverLabel={server.label}
            open={addingServerHost}
            onOpenChange={setAddingServerHost}
            onSaved={server.onTargetsChanged}
          />
        </div>

        <div className="space-y-1">
          <label className="text-[11px] font-medium text-muted-foreground">
            {translate('auto.components.sidebar.AddRepoRemoteStep.ef410aa881', 'Host path')}
          </label>
          <div className="flex gap-2">
            <Input
              value={remotePath}
              onChange={(event) => onRemotePathChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                  event.preventDefault()
                  if (selectedTargetId && remotePath.trim() && !isAddingRemote) {
                    onAdd()
                  }
                }
              }}
              placeholder={translate(
                'auto.components.sidebar.AddRepoRemoteStep.6680289908',
                '/home/user/project'
              )}
              className="h-8 text-xs flex-1"
              disabled={isAddingRemote || !selectedTargetId || !selectedTargetConnected}
            />
            <Button
              variant="outline"
              size="sm"
              className="h-8 px-2 shrink-0"
              onClick={() => setBrowsing(true)}
              disabled={!selectedTargetId || !selectedTargetConnected || isAddingRemote}
            >
              <FolderOpen className="size-3.5" />
            </Button>
          </div>
        </div>

        {remoteError ? <p className="text-[11px] text-destructive">{remoteError}</p> : null}

        <Button
          onClick={onAdd}
          disabled={
            !selectedTargetId || !selectedTargetConnected || !remotePath.trim() || isAddingRemote
          }
          className="w-full"
        >
          {isAddingRemote
            ? translate('auto.components.sidebar.AddRepoRemoteStep.35831a7312', 'Adding...')
            : translate(
                'auto.components.sidebar.AddRepoRemoteStep.36d427bb66',
                'Add project on SSH host'
              )}
        </Button>
      </div>
    </>
  )
}
