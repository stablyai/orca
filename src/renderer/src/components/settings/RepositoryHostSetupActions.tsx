import { useState } from 'react'
import { Plus, X } from 'lucide-react'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import type {
  ProjectHostSetup,
  ProjectHostSetupCreateResult,
  ProjectHostSetupResult
} from '../../../../shared/types'
import { translate } from '@/i18n/i18n'
import { Button } from '../ui/button'
import { Label } from '../ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import type { SetupHostOption } from './repository-host-setup-options'
import {
  HostSetupCloneStep,
  HostSetupExistingFolderStep,
  HostSetupPlannedStep,
  HostSetupStartActions
} from './repository-host-add-project-steps'

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
  onSetupReady: (hostId: ExecutionHostId) => void
}

type SetupStep = 'choose' | 'existing' | 'clone' | 'planned'

export function RepositoryHostSetupActions({
  repoDisplayName,
  selectedProjectHostSetup,
  setupHostOptions,
  setupProjectExistingFolder,
  setupProjectClone,
  createProjectHostSetup,
  onSetupReady
}: RepositoryHostSetupActionsProps): React.JSX.Element | null {
  const [isOpen, setIsOpen] = useState(false)
  const [step, setStep] = useState<SetupStep>('choose')
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

  const resetFlow = (): void => {
    setIsOpen(false)
    setStep('choose')
    setSelectedSetupHostId(null)
    setSetupPath('')
    setCloneUrl('')
    setCloneDestination('')
  }

  const handleExistingFolder = async (): Promise<void> => {
    if (!setupTargetHostId || !canUseSetupTargetHost || !setupPath.trim()) {
      return
    }
    setIsSettingUp(true)
    try {
      const result = await setupProjectExistingFolder({
        projectId: selectedProjectHostSetup.projectId,
        hostId: setupTargetHostId,
        path: setupPath.trim(),
        kind: setupKind,
        displayName: repoDisplayName
      })
      if (result) {
        resetFlow()
        onSetupReady(setupTargetHostId)
      }
    } finally {
      setIsSettingUp(false)
    }
  }

  const handleClone = async (): Promise<void> => {
    if (
      !setupTargetHostId ||
      !canUseSetupTargetHost ||
      !cloneUrl.trim() ||
      !cloneDestination.trim()
    ) {
      return
    }
    setIsCloning(true)
    try {
      const result = await setupProjectClone({
        projectId: selectedProjectHostSetup.projectId,
        hostId: setupTargetHostId,
        url: cloneUrl.trim(),
        destination: cloneDestination.trim(),
        displayName: repoDisplayName
      })
      if (result) {
        resetFlow()
        onSetupReady(setupTargetHostId)
      }
    } finally {
      setIsCloning(false)
    }
  }

  const handleCreatePendingSetup = async (): Promise<void> => {
    if (!setupTargetHostId || !canUseSetupTargetHost) {
      return
    }
    setIsCreatingPendingSetup(true)
    try {
      const result = await createProjectHostSetup({
        projectId: selectedProjectHostSetup.projectId,
        hostId: setupTargetHostId,
        displayName: repoDisplayName,
        setupState: 'not-set-up',
        setupMethod: 'provisioned'
      })
      if (result) {
        resetFlow()
      }
    } finally {
      setIsCreatingPendingSetup(false)
    }
  }

  if (!isOpen) {
    return (
      <div className="flex items-center justify-between gap-3 rounded-md border border-border bg-muted/20 p-3">
        <div className="min-w-0 space-y-1">
          <Label className="text-sm font-semibold">
            {translate(
              'auto.components.settings.RepositoryPane.hostAvailability',
              'Host availability'
            )}
          </Label>
          <p className="text-xs text-muted-foreground">
            {translate(
              'auto.components.settings.RepositoryPane.hostAvailabilityHelp',
              'Add this same project on another connected host.'
            )}
          </p>
        </div>
        <Button type="button" variant="outline" size="sm" onClick={() => setIsOpen(true)}>
          <Plus className="size-4" />
          {translate(
            'auto.components.settings.RepositoryPane.addToAnotherHost',
            'Add to another host'
          )}
        </Button>
      </div>
    )
  }

  return (
    <div className="space-y-3 rounded-md border border-border bg-background p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <Label className="text-sm font-semibold">
            {translate(
              'auto.components.settings.RepositoryPane.addProjectHost',
              'Add project to host'
            )}
          </Label>
          <p className="text-xs text-muted-foreground">
            {translate(
              'auto.components.settings.RepositoryPane.addProjectHostHelp',
              'Choose where this project should also be available.'
            )}
          </p>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={translate('auto.components.settings.RepositoryPane.closeHostSetup', 'Close')}
          onClick={resetFlow}
        >
          <X className="size-4" />
        </Button>
      </div>

      <div className="space-y-2">
        <Label className="text-xs font-medium text-muted-foreground">
          {translate('auto.components.settings.RepositoryPane.setupHostLabel', 'Host')}
        </Label>
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
        {!canUseSetupTargetHost && setupTargetHostOption ? (
          <p className="text-xs text-muted-foreground">{setupTargetHostOption.detail}</p>
        ) : null}
      </div>

      {step === 'choose' ? (
        <HostSetupStartActions
          disabled={!canUseSetupTargetHost}
          onBrowse={() => setStep('existing')}
          onClone={() => setStep('clone')}
          onPlan={() => setStep('planned')}
        />
      ) : null}
      {step === 'existing' ? (
        <HostSetupExistingFolderStep
          setupPath={setupPath}
          setupKind={setupKind}
          disabled={!canUseSetupTargetHost}
          isSettingUp={isSettingUp}
          onBack={() => setStep('choose')}
          onPathChange={setSetupPath}
          onKindChange={setSetupKind}
          onSubmit={handleExistingFolder}
        />
      ) : null}
      {step === 'clone' ? (
        <HostSetupCloneStep
          cloneUrl={cloneUrl}
          cloneDestination={cloneDestination}
          disabled={!canUseSetupTargetHost}
          isCloning={isCloning}
          onBack={() => setStep('choose')}
          onCloneUrlChange={setCloneUrl}
          onCloneDestinationChange={setCloneDestination}
          onSubmit={handleClone}
        />
      ) : null}
      {step === 'planned' ? (
        <HostSetupPlannedStep
          disabled={!canUseSetupTargetHost}
          isCreatingPendingSetup={isCreatingPendingSetup}
          hostLabel={setupTargetHostOption?.label ?? ''}
          onBack={() => setStep('choose')}
          onSubmit={handleCreatePendingSetup}
        />
      ) : null}
    </div>
  )
}
