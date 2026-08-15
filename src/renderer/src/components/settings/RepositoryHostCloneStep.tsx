import { useState } from 'react'
import { ArrowLeft, FolderOpen } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { parseExecutionHostId, type ExecutionHostId } from '../../../../shared/execution-host'
import { RemoteFileBrowser } from '../sidebar/RemoteFileBrowser'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'
import {
  getCloneFolderNamePreview,
  getClonePathPreview
} from './repository-host-clone-path-preview'
import { GitHubRepositoryPicker } from './GitHubRepositoryPicker'

type RepositoryHostCloneStepProps = {
  hostId: ExecutionHostId
  cloneUrl: string
  cloneDestination: string
  disabled: boolean
  isCloning: boolean
  onBack: () => void
  onCloneUrlChange: (value: string) => void
  onCloneDestinationChange: (value: string) => void
  onSubmit: () => void
}

export function RepositoryHostCloneStep({
  hostId,
  cloneUrl,
  cloneDestination,
  disabled,
  isCloning,
  onBack,
  onCloneUrlChange,
  onCloneDestinationChange,
  onSubmit
}: RepositoryHostCloneStepProps): React.JSX.Element {
  const [browsingDestination, setBrowsingDestination] = useState(false)
  const parsedHost = parseExecutionHostId(hostId)
  const canBrowseRemoteHost = parsedHost?.kind === 'ssh' || parsedHost?.kind === 'runtime'
  const clonePathPreview = getClonePathPreview(
    cloneDestination,
    getCloneFolderNamePreview(cloneUrl)
  )

  if (browsingDestination && canBrowseRemoteHost) {
    const browserProps =
      parsedHost.kind === 'ssh'
        ? { targetId: parsedHost.targetId }
        : { runtimeEnvironmentId: parsedHost.environmentId }
    return (
      <div className="space-y-3 rounded-md border border-border bg-muted/20 p-3">
        <CloneStepBackButton
          onBack={() => setBrowsingDestination(false)}
          label={translate(
            'auto.components.settings.RepositoryHostCloneStep.9718c9172b',
            'Browse host filesystem'
          )}
        />
        <p className="text-xs text-muted-foreground">
          {translate(
            'auto.components.settings.RepositoryHostCloneStep.dd432fb54c',
            'Choose the directory where Orca should create the repository folder.'
          )}
        </p>
        <RemoteFileBrowser
          key={hostId}
          {...browserProps}
          initialPath={cloneDestination || '~'}
          selectionPurpose="create-inside"
          onSelect={(path) => {
            onCloneDestinationChange(path)
            setBrowsingDestination(false)
          }}
          onCancel={() => setBrowsingDestination(false)}
        />
      </div>
    )
  }

  const browseDestination = async (): Promise<void> => {
    if (canBrowseRemoteHost) {
      setBrowsingDestination(true)
      return
    }
    const path = await window.api.repos.pickDirectory()
    if (path) {
      onCloneDestinationChange(path)
    }
  }
  const browseLabel = canBrowseRemoteHost
    ? translate(
        'auto.components.settings.RepositoryHostCloneStep.9718c9172b',
        'Browse host filesystem'
      )
    : translate('auto.components.settings.RepositoryHostCloneStep.287b80e006', 'Choose folder')

  return (
    <div className="space-y-3 rounded-md border border-border bg-muted/20 p-3">
      <CloneStepBackButton
        onBack={onBack}
        label={translate('auto.components.settings.RepositoryPane.cloneFromUrl', 'Clone from URL')}
      />
      <div className="space-y-1.5">
        <div className="flex items-center justify-between gap-3">
          <Label className="text-xs">
            {translate(
              'auto.components.settings.RepositoryHostCloneStep.2d9b8fcbe2',
              'Repository URL'
            )}
          </Label>
          <GitHubRepositoryPicker
            currentUrl={cloneUrl}
            disabled={disabled || isCloning}
            onSelect={onCloneUrlChange}
          />
        </div>
        <Input
          value={cloneUrl}
          onChange={(event) => onCloneUrlChange(event.target.value)}
          placeholder={translate(
            'auto.components.settings.RepositoryPane.cloneUrlPlaceholder',
            'https://github.com/owner/repository.git'
          )}
          className="h-9 min-w-0"
          disabled={isCloning}
          autoFocus
        />
      </div>
      <div className="space-y-1.5">
        <Label className="text-xs">
          {translate(
            'auto.components.settings.RepositoryHostCloneStep.dfb6632216',
            'Parent folder'
          )}
        </Label>
        <div className="flex gap-2">
          <Input
            value={cloneDestination}
            onChange={(event) => onCloneDestinationChange(event.target.value)}
            placeholder={translate(
              'auto.components.settings.RepositoryPane.cloneDestinationPlaceholder',
              '/parent/directory/on/host'
            )}
            className="h-9 min-w-0 flex-1 font-mono text-xs"
            disabled={isCloning}
            spellCheck={false}
          />
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="outline"
                size="icon-sm"
                className="size-9 shrink-0"
                disabled={disabled || isCloning}
                onClick={() => void browseDestination()}
                aria-label={browseLabel}
              >
                <FolderOpen className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={4}>
              {browseLabel}
            </TooltipContent>
          </Tooltip>
        </div>
        <p className="text-[11px] text-muted-foreground">
          {clonePathPreview
            ? translate(
                'auto.components.settings.RepositoryHostCloneStep.372cff9ced',
                'Creates {{path}}',
                { path: clonePathPreview }
              )
            : translate(
                'auto.components.settings.RepositoryHostCloneStep.a00f0d9e1f',
                'Orca creates the repository folder inside this directory.'
              )}
        </p>
      </div>
      <div className="flex justify-end">
        <Button
          type="button"
          size="sm"
          disabled={disabled || !cloneUrl.trim() || !cloneDestination.trim() || isCloning}
          onClick={onSubmit}
        >
          {isCloning
            ? translate('auto.components.settings.RepositoryPane.cloningHost', 'Cloning...')
            : translate('auto.components.settings.RepositoryPane.cloneHost', 'Clone')}
        </Button>
      </div>
    </div>
  )
}

function CloneStepBackButton({
  onBack,
  label
}: {
  onBack: () => void
  label: string
}): React.JSX.Element {
  return (
    <Button type="button" variant="ghost" size="sm" className="-ml-2 gap-2" onClick={onBack}>
      <ArrowLeft className="size-4" />
      {label}
    </Button>
  )
}
