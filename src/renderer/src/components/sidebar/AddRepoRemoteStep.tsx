import { useState } from 'react'
import { CircleStop, FolderOpen, Settings } from 'lucide-react'
import { DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { SshConnectionState, SshTarget } from '../../../../shared/ssh-types'
import { RemoteFileBrowser } from './RemoteFileBrowser'
import { SshTargetRow } from './SshTargetRow'
import { translate } from '@/i18n/i18n'

type RemoteStepProps = {
  sshTargets: (SshTarget & { state?: SshConnectionState })[]
  selectedTargetId: string | null
  remotePath: string
  remoteError: string | null
  isAddingRemote: boolean
  isScanningNested?: boolean
  onSelectTarget: (id: string) => void
  onRemotePathChange: (value: string) => void
  onAdd: () => void
  onOpenSshSettings: () => void
  onConnectTarget: (id: string) => Promise<void>
  onStopNestedScan?: () => void
}

export function RemoteStep({
  sshTargets,
  selectedTargetId,
  remotePath,
  remoteError,
  isAddingRemote,
  isScanningNested,
  onSelectTarget,
  onRemotePathChange,
  onAdd,
  onOpenSshSettings,
  onConnectTarget,
  onStopNestedScan
}: RemoteStepProps): React.JSX.Element {
  const [browsing, setBrowsing] = useState(false)

  if (browsing && selectedTargetId) {
    return (
      <>
        <DialogHeader>
          <DialogTitle>{translate("auto.components.sidebar.AddRepoRemoteStep.dd3ff65486", "Browse remote filesystem")}</DialogTitle>
          <DialogDescription>
            {translate("auto.components.sidebar.AddRepoRemoteStep.007651bdf9", "Navigate to a directory and click Select to choose it.")}</DialogDescription>
        </DialogHeader>
        <RemoteFileBrowser
          targetId={selectedTargetId}
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
        <DialogTitle>{translate("auto.components.sidebar.AddRepoRemoteStep.91b93a90a4", "Open remote project")}</DialogTitle>
        <DialogDescription>
          {translate("auto.components.sidebar.AddRepoRemoteStep.80557be85a", "Choose a connected SSH target and enter the path to a Git repository.")}</DialogDescription>
      </DialogHeader>

      <div className="space-y-3 pt-1">
        <div className="space-y-1">
          <label className="text-[11px] font-medium text-muted-foreground">{translate("auto.components.sidebar.AddRepoRemoteStep.44637f43bd", "SSH target")}</label>
          {sshTargets.length === 0 ? (
            <div className="space-y-1.5 py-1">
              <p className="text-xs text-muted-foreground">{translate("auto.components.sidebar.AddRepoRemoteStep.df6fbcf880", "No SSH targets configured.")}</p>
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-xs"
                onClick={onOpenSshSettings}
              >
                <Settings className="size-3.5" />
                {translate("auto.components.sidebar.AddRepoRemoteStep.0416bde073", "Add in Settings")}</Button>
            </div>
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
        </div>

        <div className="space-y-1">
          <label className="text-[11px] font-medium text-muted-foreground">{translate("auto.components.sidebar.AddRepoRemoteStep.ef410aa881", "Remote path")}</label>
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
              placeholder={translate("auto.components.sidebar.AddRepoRemoteStep.6680289908", "/home/user/project")}
              className="h-8 text-xs flex-1"
              disabled={isAddingRemote || !selectedTargetId}
            />
            <Button
              variant="outline"
              size="sm"
              className="h-8 px-2 shrink-0"
              onClick={() => setBrowsing(true)}
              disabled={!selectedTargetId || isAddingRemote}
            >
              <FolderOpen className="size-3.5" />
            </Button>
          </div>
        </div>

        {remoteError ? <p className="text-[11px] text-destructive">{remoteError}</p> : null}

        <Button
          onClick={onAdd}
          disabled={!selectedTargetId || !remotePath.trim() || isAddingRemote}
          className="w-full"
        >
          {isAddingRemote ? translate("auto.components.sidebar.AddRepoRemoteStep.35831a7312", "Adding...") : translate("auto.components.sidebar.AddRepoRemoteStep.36d427bb66", "Add remote project")}
        </Button>
        {isScanningNested ? (
          <Button variant="outline" className="w-full" onClick={onStopNestedScan}>
            <CircleStop className="size-3.5" />
            {translate("auto.components.sidebar.AddRepoRemoteStep.5b205b5281", "Stop scan")}</Button>
        ) : null}
      </div>
    </>
  )
}
