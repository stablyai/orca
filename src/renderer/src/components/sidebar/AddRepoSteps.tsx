/**
 * Step views for AddRepoDialog: Clone, Remote, and Setup.
 *
 * Why extracted: keeps AddRepoDialog.tsx under the 400-line oxlint limit
 * by moving the presentational JSX for each wizard step into separate components
 * while the parent retains all state and handlers.
 */
import React from 'react'
import { Folder } from 'lucide-react'
import { DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { SshTarget, SshConnectionState } from '../../../../shared/ssh-types'

// ── Remote step ──────────────────────────────────────────────────────

type RemoteStepProps = {
  sshTargets: (SshTarget & { state?: SshConnectionState })[]
  selectedTargetId: string | null
  remotePath: string
  remoteError: string | null
  isAddingRemote: boolean
  onSelectTarget: (id: string) => void
  onRemotePathChange: (value: string) => void
  onAdd: () => void
}

export function RemoteStep({
  sshTargets,
  selectedTargetId,
  remotePath,
  remoteError,
  isAddingRemote,
  onSelectTarget,
  onRemotePathChange,
  onAdd
}: RemoteStepProps): React.JSX.Element {
  return (
    <>
      <DialogHeader>
        <DialogTitle>Open remote repo</DialogTitle>
        <DialogDescription>
          Choose a connected SSH target and enter the path to a Git repository.
        </DialogDescription>
      </DialogHeader>

      <div className="space-y-3 pt-1">
        <div className="space-y-1">
          <label className="text-[11px] font-medium text-muted-foreground">SSH target</label>
          {sshTargets.length === 0 ? (
            <p className="text-xs text-muted-foreground py-2">
              No SSH targets configured. Add one in Settings first.
            </p>
          ) : (
            <div className="space-y-1.5">
              {sshTargets.map((target) => {
                const isConnected = target.state?.status === 'connected'
                const isSelected = selectedTargetId === target.id
                return (
                  <button
                    key={target.id}
                    className={`w-full flex items-center gap-2 px-3 py-2 rounded-md border text-xs transition-colors cursor-pointer ${
                      isSelected
                        ? 'border-foreground/30 bg-accent'
                        : 'border-border hover:bg-accent/50'
                    } ${!isConnected ? 'opacity-50' : ''}`}
                    onClick={() => {
                      if (isConnected) {
                        onSelectTarget(target.id)
                      }
                    }}
                    disabled={!isConnected}
                  >
                    <span
                      className={`size-2 rounded-full shrink-0 ${isConnected ? 'bg-green-500' : 'bg-muted-foreground/30'}`}
                    />
                    <span className="font-medium truncate">
                      {target.label || `${target.username}@${target.host}`}
                    </span>
                    {!isConnected && (
                      <span className="text-muted-foreground ml-auto">Not connected</span>
                    )}
                  </button>
                )
              })}
            </div>
          )}
        </div>

        <div className="space-y-1">
          <label className="text-[11px] font-medium text-muted-foreground">Remote path</label>
          <Input
            value={remotePath}
            onChange={(e) => onRemotePathChange(e.target.value)}
            placeholder="/home/user/project"
            className="h-8 text-xs"
            disabled={isAddingRemote}
          />
        </div>

        {remoteError && <p className="text-[11px] text-destructive">{remoteError}</p>}

        <Button
          onClick={onAdd}
          disabled={!selectedTargetId || !remotePath.trim() || isAddingRemote}
          className="w-full"
        >
          {isAddingRemote ? 'Adding...' : 'Add remote repo'}
        </Button>
      </div>
    </>
  )
}

// ── Clone step ───────────────────────────────────────────────────────

type CloneStepProps = {
  cloneUrl: string
  cloneDestination: string
  cloneError: string | null
  cloneProgress: { phase: string; percent: number } | null
  isCloning: boolean
  onUrlChange: (value: string) => void
  onDestChange: (value: string) => void
  onPickDestination: () => void
  onClone: () => void
}

export function CloneStep({
  cloneUrl,
  cloneDestination,
  cloneError,
  cloneProgress,
  isCloning,
  onUrlChange,
  onDestChange,
  onPickDestination,
  onClone
}: CloneStepProps): React.JSX.Element {
  return (
    <>
      <DialogHeader>
        <DialogTitle>Clone from URL</DialogTitle>
        <DialogDescription>Enter the Git URL and choose where to clone it.</DialogDescription>
      </DialogHeader>

      <div className="space-y-3 pt-1">
        <div className="space-y-1">
          <label className="text-[11px] font-medium text-muted-foreground">Git URL</label>
          <Input
            value={cloneUrl}
            onChange={(e) => onUrlChange(e.target.value)}
            placeholder="https://github.com/user/repo.git"
            className="h-8 text-xs"
            disabled={isCloning}
            autoFocus
          />
        </div>

        <div className="space-y-1">
          <label className="text-[11px] font-medium text-muted-foreground">Clone location</label>
          <div className="flex gap-2">
            <Input
              value={cloneDestination}
              onChange={(e) => onDestChange(e.target.value)}
              placeholder="/path/to/destination"
              className="h-8 text-xs flex-1"
              disabled={isCloning}
            />
            <Button
              variant="outline"
              size="sm"
              className="h-8 px-2 shrink-0"
              onClick={onPickDestination}
              disabled={isCloning}
            >
              <Folder className="size-3.5" />
            </Button>
          </div>
        </div>

        {cloneError && <p className="text-[11px] text-destructive">{cloneError}</p>}

        <Button
          onClick={onClone}
          disabled={!cloneUrl.trim() || !cloneDestination.trim() || isCloning}
          className="w-full"
        >
          {isCloning ? 'Cloning...' : 'Clone'}
        </Button>

        {/* Why: progress bar lives below the button so it doesn't push the
           button down when it appears mid-clone. */}
        {isCloning && cloneProgress && (
          <div className="space-y-1.5">
            <div className="flex items-center justify-between text-[11px] text-muted-foreground">
              <span>{cloneProgress.phase}</span>
              <span>{cloneProgress.percent}%</span>
            </div>
            <div className="h-1.5 w-full rounded-full bg-secondary overflow-hidden">
              <div
                className="h-full rounded-full bg-foreground transition-[width] duration-300 ease-out"
                style={{ width: `${cloneProgress.percent}%` }}
              />
            </div>
          </div>
        )}
      </div>
    </>
  )
}
