import React, { useState } from 'react'
import { Folder } from 'lucide-react'
import { DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { translate } from '@/i18n/i18n'
import { RemoteFileBrowser } from './RemoteFileBrowser'

type CloneStepProps = {
  cloneUrl: string
  cloneDestination: string
  cloneError: string | null
  cloneProgress: { phase: string; percent: number } | null
  isCloning: boolean
  disableDestinationPicker?: boolean
  runtimeEnvironmentId?: string | null
  sshTargetId?: string | null
  cloneTargetLabel?: string | null
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
  disableDestinationPicker = false,
  runtimeEnvironmentId,
  sshTargetId,
  cloneTargetLabel,
  onUrlChange,
  onDestChange,
  onPickDestination,
  onClone
}: CloneStepProps): React.JSX.Element {
  const [browsingDestination, setBrowsingDestination] = useState(false)
  const isRemoteClone = Boolean(runtimeEnvironmentId || sshTargetId)
  const canBrowseRemoteDestination = isRemoteClone
  const canClone = !!cloneUrl.trim() && !!cloneDestination.trim() && !isCloning
  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      e.preventDefault()
      if (canClone) {
        onClone()
      }
    }
  }

  if (browsingDestination && (runtimeEnvironmentId || sshTargetId)) {
    return (
      <>
        <DialogHeader>
          <DialogTitle>
            {translate('auto.components.sidebar.AddRepoSteps.a93ef169b5', 'Browse host filesystem')}
          </DialogTitle>
          <DialogDescription>
            {translate(
              'auto.components.sidebar.AddRepoSteps.fe8e629fe3',
              'Navigate to a directory and click Select to choose it.'
            )}
          </DialogDescription>
        </DialogHeader>
        {sshTargetId ? (
          <RemoteFileBrowser
            targetId={sshTargetId}
            initialPath={cloneDestination || '~'}
            onSelect={(path) => {
              onDestChange(path)
              setBrowsingDestination(false)
            }}
            onCancel={() => setBrowsingDestination(false)}
          />
        ) : (
          <RemoteFileBrowser
            runtimeEnvironmentId={runtimeEnvironmentId as string}
            initialPath={cloneDestination || '~'}
            onSelect={(path) => {
              onDestChange(path)
              setBrowsingDestination(false)
            }}
            onCancel={() => setBrowsingDestination(false)}
          />
        )}
      </>
    )
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>
          {translate('auto.components.sidebar.AddRepoSteps.c05f88a31f', 'Clone from URL')}
        </DialogTitle>
        <DialogDescription>
          {cloneTargetLabel
            ? translate(
                'auto.components.sidebar.AddRepoSteps.cloneOnHostDescription',
                'Enter the Git URL and choose where to clone it on {{value0}}.',
                { value0: cloneTargetLabel }
              )
            : translate(
                'auto.components.sidebar.AddRepoSteps.5b2ea674b1',
                'Enter the Git URL and choose where to clone it.'
              )}
        </DialogDescription>
      </DialogHeader>

      <div className="space-y-3 pt-1">
        <div className="space-y-1">
          <label className="text-[11px] font-medium text-muted-foreground">
            {translate('auto.components.sidebar.AddRepoSteps.3d4acbe693', 'Git URL')}
          </label>
          <Input
            value={cloneUrl}
            onChange={(e) => onUrlChange(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={translate(
              'auto.components.sidebar.AddRepoSteps.b698a4a29d',
              'https://github.com/user/repo.git'
            )}
            className="h-8 text-xs"
            disabled={isCloning}
            autoFocus
          />
        </div>

        <div className="space-y-1">
          <label className="text-[11px] font-medium text-muted-foreground">
            {translate('auto.components.sidebar.AddRepoSteps.cloneParentFolder', 'Parent folder')}
          </label>
          <div className="flex gap-2">
            <Input
              value={cloneDestination}
              onChange={(e) => onDestChange(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={translate(
                isRemoteClone
                  ? 'auto.components.sidebar.AddRepoSteps.remoteCloneParentPlaceholder'
                  : 'auto.components.sidebar.AddRepoSteps.2ce3f6edf8',
                isRemoteClone ? '/home/user/projects' : '/path/to/destination'
              )}
              className="h-8 text-xs flex-1"
              disabled={isCloning}
            />
            <Button
              variant="outline"
              size="sm"
              className="h-8 px-2 shrink-0"
              onClick={() => {
                if (canBrowseRemoteDestination) {
                  setBrowsingDestination(true)
                  return
                }
                onPickDestination()
              }}
              disabled={isCloning || (disableDestinationPicker && !canBrowseRemoteDestination)}
              title={
                canBrowseRemoteDestination
                  ? translate(
                      'auto.components.sidebar.AddRepoSteps.a93ef169b5',
                      'Browse host filesystem'
                    )
                  : translate('auto.components.sidebar.AddRepoSteps.569326d9cc', 'Choose folder')
              }
              aria-label={
                canBrowseRemoteDestination
                  ? translate(
                      'auto.components.sidebar.AddRepoSteps.a93ef169b5',
                      'Browse host filesystem'
                    )
                  : translate('auto.components.sidebar.AddRepoSteps.569326d9cc', 'Choose folder')
              }
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
          {isCloning
            ? translate('auto.components.sidebar.AddRepoSteps.69f5b5380d', 'Cloning...')
            : translate('auto.components.sidebar.AddRepoSteps.32a7256d85', 'Clone')}
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
