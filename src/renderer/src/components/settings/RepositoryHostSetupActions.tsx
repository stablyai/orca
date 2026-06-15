import { useState } from 'react'
import { type ExecutionHostId } from '../../../../shared/execution-host'
import type {
  ProjectHostSetup,
  ProjectHostSetupCreateResult,
  ProjectHostSetupResult
} from '../../../../shared/types'
import { translate } from '@/i18n/i18n'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import type { SetupHostOption } from './repository-host-setup-options'

type RepositoryHostSetupActionsProps = {
  repoDisplayName: string
  selectedProjectHostSetup: ProjectHostSetup
  setupHostOptions: SetupHostOption[]
  setupProjectExistingFolder: (args: {
    projectId: string
    hostId: ExecutionHostId
    path: string
    kind: 'git' | 'folder'
    displayName: string
  }) => Promise<ProjectHostSetupResult | null>
  setupProjectClone: (args: {
    projectId: string
    hostId: ExecutionHostId
    url: string
    destination: string
    displayName: string
  }) => Promise<ProjectHostSetupResult | null>
  createProjectHostSetup: (args: {
    projectId: string
    hostId: ExecutionHostId
    displayName: string
    setupState: 'not-set-up'
    setupMethod: 'provisioned'
  }) => Promise<ProjectHostSetupCreateResult | null>
  onOpenSetup: (repoId: string) => void
}

export function RepositoryHostSetupActions({
  repoDisplayName,
  selectedProjectHostSetup,
  setupHostOptions,
  setupProjectExistingFolder,
  setupProjectClone,
  createProjectHostSetup,
  onOpenSetup
}: RepositoryHostSetupActionsProps): React.JSX.Element | null {
  const [selectedSetupHostId, setSelectedSetupHostId] = useState<ExecutionHostId | null>(null)
  const [setupPath, setSetupPath] = useState('')
  const [setupKind, setSetupKind] = useState<'git' | 'folder'>('git')
  const [cloneUrl, setCloneUrl] = useState('')
  const [cloneDestination, setCloneDestination] = useState('')
  const [isSettingUp, setIsSettingUp] = useState(false)
  const [isCloning, setIsCloning] = useState(false)
  const [isCreatingPendingSetup, setIsCreatingPendingSetup] = useState(false)
  const defaultSetupHostOption =
    setupHostOptions.find((option) => option.isAvailable) ?? setupHostOptions[0] ?? null
  const setupTargetHostId = selectedSetupHostId ?? defaultSetupHostOption?.id ?? null
  const setupTargetHostOption =
    setupHostOptions.find((option) => option.id === setupTargetHostId) ?? null
  const canUseSetupTargetHost = setupTargetHostOption?.isAvailable ?? false

  if (setupHostOptions.length === 0) {
    return null
  }

  return (
    <div className="space-y-3 rounded-md border border-border bg-muted/20 p-3">
      <div className="space-y-1">
        <Label className="text-sm font-semibold">
          {translate(
            'auto.components.settings.RepositoryPane.setupProjectOnHost',
            'Set up on another host'
          )}
        </Label>
        <p className="text-xs text-muted-foreground">
          {translate(
            'auto.components.settings.RepositoryPane.setupProjectOnHostHelp',
            'Choose a host, then import an existing checkout, clone the repository there, or track a setup that will be provisioned later.'
          )}
        </p>
      </div>
      <div className="max-w-48">
        <Select
          value={setupTargetHostId ?? undefined}
          onValueChange={(value) => setSelectedSetupHostId(value as ExecutionHostId)}
        >
          <SelectTrigger className="h-9 min-w-0">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {setupHostOptions.map((option) => (
              <SelectItem key={option.id} value={option.id} disabled={!option.isAvailable}>
                <span className="min-w-0">
                  <span className="block truncate">{option.label}</span>
                  {!option.isAvailable ? (
                    <span className="block truncate text-[11px] text-muted-foreground">
                      {option.detail}
                    </span>
                  ) : null}
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto_auto]">
        <Input
          value={setupPath}
          onChange={(event) => setSetupPath(event.target.value)}
          placeholder={translate(
            'auto.components.settings.RepositoryPane.setupExistingFolderPathPlaceholder',
            '/path/to/project/on/host'
          )}
          className="h-9 min-w-0"
        />
        <Select
          value={setupKind}
          onValueChange={(value) => setSetupKind(value as 'git' | 'folder')}
        >
          <SelectTrigger className="h-9 w-32 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="git">
              {translate('auto.components.settings.RepositoryPane.setupKindGit', 'Git repo')}
            </SelectItem>
            <SelectItem value="folder">
              {translate('auto.components.settings.RepositoryPane.setupKindFolder', 'Folder')}
            </SelectItem>
          </SelectContent>
        </Select>
        <Button
          type="button"
          size="sm"
          disabled={!canUseSetupTargetHost || !setupPath.trim() || isSettingUp}
          onClick={async () => {
            if (!setupTargetHostId || !canUseSetupTargetHost || !setupPath.trim()) {
              return
            }
            setIsSettingUp(true)
            const result = await setupProjectExistingFolder({
              projectId: selectedProjectHostSetup.projectId,
              hostId: setupTargetHostId,
              path: setupPath.trim(),
              kind: setupKind,
              displayName: repoDisplayName
            })
            setIsSettingUp(false)
            if (result) {
              setSetupPath('')
              setSelectedSetupHostId(null)
              onOpenSetup(result.repo.id)
            }
          }}
        >
          {isSettingUp
            ? translate('auto.components.settings.RepositoryPane.settingUpHost', 'Importing...')
            : translate('auto.components.settings.RepositoryPane.setupHost', 'Import')}
        </Button>
      </div>
      <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
        <Input
          value={cloneUrl}
          onChange={(event) => setCloneUrl(event.target.value)}
          placeholder={translate(
            'auto.components.settings.RepositoryPane.cloneUrlPlaceholder',
            'Repository URL'
          )}
          className="h-9 min-w-0"
        />
        <Input
          value={cloneDestination}
          onChange={(event) => setCloneDestination(event.target.value)}
          placeholder={translate(
            'auto.components.settings.RepositoryPane.cloneDestinationPlaceholder',
            '/destination/on/host'
          )}
          className="h-9 min-w-0"
        />
        <Button
          type="button"
          size="sm"
          disabled={
            !canUseSetupTargetHost || !cloneUrl.trim() || !cloneDestination.trim() || isCloning
          }
          onClick={async () => {
            if (
              !setupTargetHostId ||
              !canUseSetupTargetHost ||
              !cloneUrl.trim() ||
              !cloneDestination.trim()
            ) {
              return
            }
            setIsCloning(true)
            const result = await setupProjectClone({
              projectId: selectedProjectHostSetup.projectId,
              hostId: setupTargetHostId,
              url: cloneUrl.trim(),
              destination: cloneDestination.trim(),
              displayName: repoDisplayName
            })
            setIsCloning(false)
            if (result) {
              setCloneUrl('')
              setCloneDestination('')
              setSelectedSetupHostId(null)
              onOpenSetup(result.repo.id)
            }
          }}
        >
          {isCloning
            ? translate('auto.components.settings.RepositoryPane.cloningHost', 'Cloning...')
            : translate('auto.components.settings.RepositoryPane.cloneHost', 'Clone')}
        </Button>
      </div>
      <div className="flex justify-end">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={!canUseSetupTargetHost || isCreatingPendingSetup}
          onClick={async () => {
            if (!setupTargetHostId || !canUseSetupTargetHost) {
              return
            }
            setIsCreatingPendingSetup(true)
            const result = await createProjectHostSetup({
              projectId: selectedProjectHostSetup.projectId,
              hostId: setupTargetHostId,
              displayName: repoDisplayName,
              setupState: 'not-set-up',
              setupMethod: 'provisioned'
            })
            setIsCreatingPendingSetup(false)
            if (result) {
              setSelectedSetupHostId(null)
            }
          }}
        >
          {isCreatingPendingSetup
            ? translate(
                'auto.components.settings.RepositoryPane.creatingPendingSetup',
                'Creating...'
              )
            : translate(
                'auto.components.settings.RepositoryPane.createPendingSetup',
                'Track setup'
              )}
        </Button>
      </div>
    </div>
  )
}
