import React from 'react'
import { FolderPlus, LoaderCircle, PlugZap } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import ProjectCombobox from '@/components/new-workspace/ProjectCombobox'
import RunTargetCombobox from '@/components/new-workspace/RunTargetCombobox'
import { translate } from '@/i18n/i18n'
import type { LocalCapacityCause } from '@/lib/default-run-target-suggestion'
import type {
  EphemeralVmRecipeOption,
  NeedsProjectHostOption,
  NewWorkspaceComposerCardProps
} from './new-workspace-composer-card-props'
import { EMPTY_PROJECT_OPTIONS } from './new-workspace-composer-card-props'

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
  | 'runTargetSuggestionCauses'
  | 'onEphemeralVmRecipeChange'
  | 'selectedEphemeralVmRecipeId'
  | 'ephemeralVmRecipeError'
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
}

// Why: one translated fragment per cause, so a translator never has to reorder English prose.
// Exhaustive: a new cause fails typecheck here until it has copy.
const SUGGESTION_CAUSE_COPY: Record<LocalCapacityCause, () => string> = {
  onBattery: () =>
    translate(
      'auto.components.new.workspace.RunTargetCombobox.suggestedCauseOnBattery',
      'on battery'
    ),
  lowMemory: () =>
    translate(
      'auto.components.new.workspace.RunTargetCombobox.suggestedCauseLowMemory',
      'low on memory'
    ),
  lowCpu: () =>
    translate(
      'auto.components.new.workspace.RunTargetCombobox.suggestedCauseLowCpu',
      'short on CPU cores'
    )
}

function formatSuggestionCauses(causes: readonly LocalCapacityCause[]): string {
  const fragments = causes.map((cause) => SUGGESTION_CAUSE_COPY[cause]())
  if (fragments.length <= 1) {
    return fragments[0] ?? ''
  }
  const separator = translate(
    'auto.components.new.workspace.RunTargetCombobox.suggestedCauseSeparator',
    ', '
  )
  const conjunction = translate(
    'auto.components.new.workspace.RunTargetCombobox.suggestedCauseConjunction',
    ' and '
  )
  return `${fragments.slice(0, -1).join(separator)}${conjunction}${fragments.at(-1) ?? ''}`
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
  runTargetSuggestionCauses = null,
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
    <fieldset disabled={disabled} className="space-y-1">
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
          {projectError ? (
            <p id={projectDescriptionId} className="text-[11px] text-destructive">
              {projectError}
            </p>
          ) : projectOptions.length === 0 ? (
            <p id={projectDescriptionId} className="text-[11px] text-muted-foreground">
              {emptyProjectMessage ??
                translate(
                  'auto.components.NewWorkspaceComposerCard.addProjectBeforeWorkspace',
                  'Add a project before creating a workspace.'
                )}
            </p>
          ) : null}
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
          {runTargetSuggestionCauses && runTargetSuggestionCauses.length > 0 ? (
            <p className="text-[11px] text-muted-foreground">
              {translate(
                'auto.components.new.workspace.RunTargetCombobox.suggestedBecause',
                'Suggested because this machine is {{reason}}',
                { reason: formatSuggestionCauses(runTargetSuggestionCauses) }
              )}
            </p>
          ) : null}
          {ephemeralVmRecipeError ? (
            <p className="whitespace-pre-line text-[11px] text-destructive">
              {ephemeralVmRecipeError}
            </p>
          ) : null}
        </div>
      ) : ephemeralVmRecipeError ? (
        <p className="whitespace-pre-line text-[11px] text-destructive">{ephemeralVmRecipeError}</p>
      ) : null}
      {selectedRepoRequiresConnection && selectedRepoConnectionId ? (
        <div
          role="status"
          aria-live="polite"
          className="flex items-center justify-between gap-3 rounded-md border border-border/70 bg-muted/35 px-3 py-2"
        >
          <div className="min-w-0">
            <div className="truncate text-xs font-medium text-foreground">
              {translate('auto.components.NewWorkspaceComposerCard.b5a0796911', 'Connect')}{' '}
              {selectedProjectName}
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
              ? translate('auto.components.NewWorkspaceComposerCard.f660aa1454', 'Connecting')
              : connectButtonLabel}
          </Button>
        </div>
      ) : null}
    </fieldset>
  )
}
