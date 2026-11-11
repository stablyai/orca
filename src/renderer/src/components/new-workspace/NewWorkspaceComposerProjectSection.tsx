import { OrcaCloudWallLine } from './run-on/OrcaCloudWallLine'
import React from 'react'
import { FolderPlus, LoaderCircle, PlugZap } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import ProjectCombobox from '@/components/new-workspace/ProjectCombobox'
import RunTargetCombobox from '@/components/new-workspace/RunTargetCombobox'
import { ORCA_CLOUD_RECIPE_ID } from '../../../../shared/hosted-sandbox/orca-cloud-recipe-id'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/utils'
import { getSelectedNewWorkspaceProjectOptionId } from '@/lib/new-workspace-project-options'
import type {
  EphemeralVmRecipeOption,
  NeedsProjectHostOption,
  NewWorkspaceComposerCardProps
} from './new-workspace-composer-card-props'
import { EMPTY_PROJECT_OPTIONS } from './new-workspace-composer-card-props'
import type { OrcaCloudRunTargetAccess } from './orca-cloud-run-target-access'

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
  | 'selectedRepoExecutionHostId'
  | 'onEphemeralVmRecipeChange'
  | 'selectedEphemeralVmRecipeId'
  | 'ephemeralVmRecipeError'
  | 'orcaCloudAvailability'
  | 'cloudStart'
> & {
  disabled?: boolean
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
  /** Fixtures pin Orca Cloud entitlement; the app reads it from billing. */
  orcaCloudAccess?: OrcaCloudRunTargetAccess
}

export function NewWorkspaceComposerProjectSection({
  disabled = false,
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
  selectedRepoExecutionHostId,
  handleProjectHostSetupChange,
  ephemeralVmRecipes,
  selectedEphemeralVmRecipeId = null,
  onEphemeralVmRecipeChange,
  handleAddSshHost,
  handleAddRemoteServer,
  handleConnectRunTargetHost,
  handleSetLocation,
  ephemeralVmRecipeError,
  orcaCloudAvailability = 'unavailable',
  selectedRepoRequiresConnection,
  selectedRepoConnectionId,
  selectedRepoConnectInProgress,
  onConnectSelectedRepo,
  sshStatusLabel,
  connectButtonLabel,
  selectedProjectName,
  orcaCloudAccess,
  cloudStart = null
}: NewWorkspaceComposerProjectSectionProps): React.JSX.Element {
  // D4 rows: while Orca Cloud is picked, and for a folder, which can only start from GitHub.
  const cloudOnly =
    selectedEphemeralVmRecipeId === ORCA_CLOUD_RECIPE_ID || cloudStart?.folderProject
      ? cloudStart?.cloudOnly
      : undefined
  const t = useTranslate()
  return (
    <fieldset disabled={disabled} className="space-y-1">
      {/* One row, two equal columns: Project | Run on. Picking a target never changes the rows
          below it, so the dialog keeps its height (composer-redo). */}
      <div className={cn('grid gap-3', shouldShowRunTargetPicker && 'grid-cols-2')}>
        <div className="min-w-0 space-y-1">
          <div className="flex h-5 items-center justify-between gap-2">
            <label className="text-xs font-medium text-muted-foreground">
              {projectLabel ?? t('auto.components.NewWorkspaceComposerCard.969a8bff66', 'Project')}
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
                    aria-label={t(
                      'auto.components.NewWorkspaceComposerCard.d6b0a96f32',
                      'Add project'
                    )}
                  >
                    <FolderPlus className="size-3" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="top" sideOffset={6}>
                  {t('auto.components.NewWorkspaceComposerCard.d6b0a96f32', 'Add project')}
                </TooltipContent>
              </Tooltip>
            ) : null}
          </div>
          <div className="space-y-1" data-contextual-tour-target="workspace-creation-project">
            <ProjectCombobox
              options={projectOptions}
              value={getSelectedNewWorkspaceProjectOptionId(
                projectOptions,
                selectedProjectId,
                selectedProjectHostSetupId,
                selectedRepoExecutionHostId
              )}
              onValueChange={(projectId) => {
                cloudOnly?.clear()
                onProjectChange(projectId)
              }}
              onValueSelected={focusNameInput}
              onAddProject={onAddProject}
              // D4: while Orca Cloud is picked, GitHub repositories with no clone here.
              cloudRepos={cloudOnly?.repos ?? null}
              cloudRepoValue={cloudOnly?.picked?.fullName ?? null}
              onCloudRepoSelected={(fullName) => {
                cloudOnly?.pick(fullName)
                cloudStart?.onSelectOrcaCloud()
              }}
              onMoreCloudAccess={cloudOnly?.moreAccess}
              onShowMoreCloudRepos={cloudOnly?.showMore ?? null}
              placeholder={
                projectPlaceholder ??
                t('auto.components.NewWorkspaceComposerCard.dccd26d4e4', 'Choose project')
              }
              triggerClassName="h-9 w-full border-input text-sm focus-visible:border-focus-ring focus-visible:ring-1 focus-visible:ring-focus-ring"
              invalid={Boolean(projectError)}
              describedBy={projectDescriptionId}
            />
            {projectError ? (
              <p id={projectDescriptionId} className="text-[11px] text-destructive">
                {projectError}
              </p>
            ) : projectOptions.length === 0 ? (
              <p id={projectDescriptionId} className="text-[11px] text-muted-foreground">
                {emptyProjectMessage ??
                  t(
                    'auto.components.NewWorkspaceComposerCard.addProjectBeforeWorkspace',
                    'Add a project before creating a workspace.'
                  )}
              </p>
            ) : null}
          </div>
        </div>
        {shouldShowRunTargetPicker ? (
          <div className="min-w-0 space-y-1">
            <label className="flex h-5 min-w-0 items-center truncate text-xs font-medium text-muted-foreground">
              {t('auto.components.NewWorkspaceComposerCard.runOn', 'Run on')}
            </label>
            <RunTargetCombobox
              hostOptions={projectHostSetupOptions ?? []}
              hostValue={selectedProjectHostSetupId ?? null}
              hostExecutionHostId={selectedRepoExecutionHostId}
              onHostChange={(setupId) => {
                cloudStart?.onUserPick()
                handleProjectHostSetupChange(setupId)
              }}
              recipes={ephemeralVmRecipes}
              recipeValue={selectedEphemeralVmRecipeId}
              onRecipeChange={(recipeId) => {
                cloudStart?.onUserPick()
                onEphemeralVmRecipeChange?.(recipeId)
              }}
              onAddSshHost={handleAddSshHost}
              onAddRemoteServer={handleAddRemoteServer}
              onConnectHost={handleConnectRunTargetHost}
              onSetLocation={handleSetLocation}
              orcaCloudAvailability={orcaCloudAvailability}
              {...(orcaCloudAccess ? { orcaCloudAccess } : {})}
              // Setup happens after Start, on its own page: picking Orca Cloud just picks it.
              {...(cloudStart ? { onSelectOrcaCloud: cloudStart.onSelectOrcaCloud } : {})}
            />
            {ephemeralVmRecipeError ? (
              <p className="whitespace-pre-line text-[11px] text-destructive">
                {ephemeralVmRecipeError}
              </p>
            ) : null}
            {cloudStart?.wall ? <OrcaCloudWallLine wall={cloudStart.wall} /> : null}
          </div>
        ) : null}
      </div>
      {!shouldShowRunTargetPicker && ephemeralVmRecipeError ? (
        <p className="whitespace-pre-line text-2xs text-destructive">{ephemeralVmRecipeError}</p>
      ) : null}
      {selectedRepoRequiresConnection && selectedRepoConnectionId ? (
        <div
          role="status"
          aria-live="polite"
          className="flex items-center justify-between gap-3 rounded-md border border-border/70 bg-muted/35 px-3 py-2"
        >
          <div className="min-w-0">
            <div className="truncate text-xs font-medium text-foreground">
              {t('auto.components.NewWorkspaceComposerCard.connectProject', 'Connect {{name}}', {
                name: selectedProjectName
              })}
            </div>
            <div className="mt-0.5 text-[11px] text-muted-foreground">{sshStatusLabel}</div>
          </div>
          <Button
            type="button"
            variant="outline"
            size="xs"
            onClick={() => void onConnectSelectedRepo()}
            disabled={selectedRepoConnectInProgress}
            className="shrink-0"
          >
            {selectedRepoConnectInProgress ? (
              <LoaderCircle className="size-3.5 animate-spin" />
            ) : (
              <PlugZap className="size-3.5" />
            )}
            {selectedRepoConnectInProgress
              ? t('auto.components.NewWorkspaceComposerCard.f660aa1454', 'Connecting')
              : connectButtonLabel}
          </Button>
        </div>
      ) : null}
    </fieldset>
  )
}
