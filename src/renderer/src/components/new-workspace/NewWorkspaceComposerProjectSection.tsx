import React from 'react'
import { FolderPlus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import ProjectCombobox from '@/components/new-workspace/ProjectCombobox'
import RunTargetCombobox from '@/components/new-workspace/RunTargetCombobox'
import { translate } from '@/i18n/i18n'
import type {
  EphemeralVmRecipeOption,
  NeedsProjectHostOption,
  NewWorkspaceComposerCardProps
} from './new-workspace-composer-card-props'
import { EMPTY_PROJECT_OPTIONS } from './new-workspace-composer-card-props'
import {
  ConnectHostNotice,
  EphemeralVmRecipeErrorNotice,
  ProjectNotice
} from './NewWorkspaceComposerTargetNotices'

type NewWorkspaceComposerProjectSectionProps = Pick<
  NewWorkspaceComposerCardProps,
  | 'projectOptions'
  | 'selectedProjectId'
  | 'onProjectChange'
  | 'projectError'
  | 'showAddProjectButton'
  | 'projectLabel'
  | 'projectPlaceholder'
  | 'emptyProjectMessage'
  | 'selectedRepoConnectionId'
  | 'selectedRepoRequiresConnection'
  | 'selectedRepoConnectInProgress'
  | 'onConnectSelectedRepo'
  | 'selectedProjectHostSetupId'
  | 'onEphemeralVmRecipeChange'
  | 'selectedEphemeralVmRecipeId'
  | 'ephemeralVmRecipeError'
> & {
  projectDescriptionId: string
  onAddProject: () => void
  focusNameInput: () => void
  shouldShowRunTargetPicker: boolean
  projectHostSetupOptions: NewWorkspaceComposerCardProps['projectHostSetupOptions']
  ephemeralVmRecipes: EphemeralVmRecipeOption[]
  handleProjectHostSetupChange: (setupId: string) => void
  handleAddSshHost: () => void
  handleAddRemoteServer: () => void
  handleConnectRunTargetHost: (option: NeedsProjectHostOption) => Promise<void>
  handleSetLocation: (option: NeedsProjectHostOption) => void
  sshStatusLabel: string
  connectButtonLabel: string
  selectedProjectName: string
}

export function NewWorkspaceComposerProjectSection({
  projectOptions = EMPTY_PROJECT_OPTIONS,
  selectedProjectId = null,
  onProjectChange,
  projectError,
  showAddProjectButton = true,
  projectLabel,
  projectPlaceholder,
  emptyProjectMessage,
  projectDescriptionId,
  onAddProject,
  focusNameInput,
  shouldShowRunTargetPicker,
  projectHostSetupOptions,
  selectedProjectHostSetupId,
  handleProjectHostSetupChange,
  ephemeralVmRecipes,
  selectedEphemeralVmRecipeId = null,
  onEphemeralVmRecipeChange,
  handleAddSshHost,
  handleAddRemoteServer,
  handleConnectRunTargetHost,
  handleSetLocation,
  ephemeralVmRecipeError,
  selectedRepoRequiresConnection,
  selectedRepoConnectionId,
  selectedRepoConnectInProgress,
  onConnectSelectedRepo,
  sshStatusLabel,
  connectButtonLabel,
  selectedProjectName
}: NewWorkspaceComposerProjectSectionProps): React.JSX.Element {
  return (
    <div className="space-y-1">
      <div className="space-y-1">
        <div className="flex items-center justify-between gap-2">
          <label className="text-xs font-medium text-muted-foreground">
            {projectLabel ??
              translate('auto.components.NewWorkspaceComposerCard.969a8bff66', 'Project')}
          </label>
          {showAddProjectButton ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  onClick={onAddProject}
                  className="size-5 shrink-0 rounded-sm text-muted-foreground hover:text-foreground"
                  aria-label={translate(
                    'auto.components.NewWorkspaceComposerCard.d6b0a96f32',
                    'Add project'
                  )}
                >
                  <FolderPlus className="size-3" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="top" sideOffset={6}>
                {translate('auto.components.NewWorkspaceComposerCard.d6b0a96f32', 'Add project')}
              </TooltipContent>
            </Tooltip>
          ) : null}
        </div>
        <div className="space-y-1" data-contextual-tour-target="workspace-creation-project">
          <ProjectCombobox
            options={projectOptions}
            value={selectedProjectId}
            onValueChange={onProjectChange}
            onValueSelected={focusNameInput}
            onAddProject={onAddProject}
            placeholder={
              projectPlaceholder ??
              translate('auto.components.NewWorkspaceComposerCard.dccd26d4e4', 'Choose project')
            }
            triggerClassName="h-9 w-full border-input text-sm focus:border-ring focus:ring-[3px] focus:ring-ring/50"
            invalid={Boolean(projectError)}
            describedBy={projectDescriptionId}
          />
          <ProjectNotice
            projectOptions={projectOptions}
            projectError={projectError}
            emptyProjectMessage={emptyProjectMessage}
            projectDescriptionId={projectDescriptionId}
          />
        </div>
      </div>
      {shouldShowRunTargetPicker ? (
        <div className="space-y-1 pt-3">
          <label className="block min-w-0 truncate text-xs font-medium text-muted-foreground">
            {translate('auto.components.NewWorkspaceComposerCard.runOn', 'Run on')}
          </label>
          <RunTargetCombobox
            hostOptions={projectHostSetupOptions ?? []}
            hostValue={selectedProjectHostSetupId ?? null}
            onHostChange={handleProjectHostSetupChange}
            recipes={ephemeralVmRecipes}
            recipeValue={selectedEphemeralVmRecipeId}
            onRecipeChange={onEphemeralVmRecipeChange}
            onAddSshHost={handleAddSshHost}
            onAddRemoteServer={handleAddRemoteServer}
            onConnectHost={handleConnectRunTargetHost}
            onSetLocation={handleSetLocation}
          />
          <EphemeralVmRecipeErrorNotice ephemeralVmRecipeError={ephemeralVmRecipeError} />
        </div>
      ) : (
        <EphemeralVmRecipeErrorNotice ephemeralVmRecipeError={ephemeralVmRecipeError} />
      )}
      <ConnectHostNotice
        selectedRepoRequiresConnection={selectedRepoRequiresConnection}
        selectedRepoConnectionId={selectedRepoConnectionId}
        selectedRepoConnectInProgress={selectedRepoConnectInProgress}
        onConnectSelectedRepo={onConnectSelectedRepo}
        sshStatusLabel={sshStatusLabel}
        connectButtonLabel={connectButtonLabel}
        selectedProjectName={selectedProjectName}
      />
    </div>
  )
}
