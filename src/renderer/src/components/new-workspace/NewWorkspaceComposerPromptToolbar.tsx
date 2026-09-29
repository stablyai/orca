import React from 'react'
import { ArrowUp, ChevronDown, LoaderCircle } from 'lucide-react'
import AgentCombobox from '@/components/agent/AgentCombobox'
import ProjectCombobox from '@/components/new-workspace/ProjectCombobox'
import RunTargetCombobox from '@/components/new-workspace/RunTargetCombobox'
import { ShortcutKeyCombo } from '@/components/ShortcutKeyCombo'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import type {
  EphemeralVmRecipeOption,
  NeedsProjectHostOption,
  NewWorkspaceComposerCardProps
} from './new-workspace-composer-card-props'
import { EMPTY_PROJECT_OPTIONS } from './new-workspace-composer-card-props'

// Why: the type-ahead fields ship as bordered form inputs; inside the prompt box they read as pills.
const PILL_FIELD_CLASS =
  'h-7 border-transparent bg-transparent px-2 shadow-none hover:bg-accent focus-within:border-transparent focus-within:ring-0 dark:bg-transparent'

type NewWorkspaceComposerPromptToolbarProps = Pick<
  NewWorkspaceComposerCardProps,
  | 'projectOptions'
  | 'selectedProjectId'
  | 'onProjectChange'
  | 'projectError'
  | 'projectPlaceholder'
  | 'selectedProjectHostSetupId'
  | 'onEphemeralVmRecipeChange'
  | 'selectedEphemeralVmRecipeId'
  | 'quickAgent'
  | 'onQuickAgentChange'
  | 'onOpenAgentSettings'
  | 'createDisabled'
  | 'creating'
  | 'onCreate'
  | 'primaryActionLabel'
  | 'advancedOpen'
  | 'onToggleAdvanced'
> & {
  projectDescriptionId: string
  onAddProject: () => void
  focusPromptInput: () => void
  shouldShowRunTargetPicker: boolean
  projectHostSetupOptions: NewWorkspaceComposerCardProps['projectHostSetupOptions']
  ephemeralVmRecipes: EphemeralVmRecipeOption[]
  handleProjectHostSetupChange: (setupId: string) => void
  handleAddSshHost: () => void
  handleAddRemoteServer: () => void
  handleConnectRunTargetHost: (option: NeedsProjectHostOption) => Promise<void>
  handleSetLocation: (option: NeedsProjectHostOption) => void
  visibleQuickAgents: React.ComponentProps<typeof AgentCombobox>['agents']
  defaultTuiAgent: React.ComponentProps<typeof AgentCombobox>['defaultAgent']
  handleSetDefaultAgent: (
    next: Parameters<NonNullable<React.ComponentProps<typeof AgentCombobox>['onSetDefault']>>[0]
  ) => void
  submitShortcutModifierLabel: string
}

export function NewWorkspaceComposerPromptToolbar({
  projectOptions = EMPTY_PROJECT_OPTIONS,
  selectedProjectId = null,
  onProjectChange,
  projectError,
  projectPlaceholder,
  projectDescriptionId,
  onAddProject,
  focusPromptInput,
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
  quickAgent,
  onQuickAgentChange,
  onOpenAgentSettings,
  visibleQuickAgents,
  defaultTuiAgent,
  handleSetDefaultAgent,
  createDisabled,
  creating,
  onCreate,
  primaryActionLabel,
  advancedOpen,
  onToggleAdvanced,
  submitShortcutModifierLabel
}: NewWorkspaceComposerPromptToolbarProps): React.JSX.Element {
  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="xs"
        onClick={onToggleAdvanced}
        className="shrink-0"
      >
        {translate('auto.components.NewWorkspaceComposerCard.f0470c7383', 'Advanced')}
        <ChevronDown className={cn('size-3 transition-transform', advancedOpen && 'rotate-180')} />
      </Button>
      <div className="ml-auto flex min-w-0 items-center justify-end gap-1">
        <div
          className="w-36 min-w-0 shrink"
          data-contextual-tour-target="workspace-creation-project"
        >
          <ProjectCombobox
            options={projectOptions}
            value={selectedProjectId}
            onValueChange={onProjectChange}
            onValueSelected={focusPromptInput}
            onAddProject={onAddProject}
            placeholder={
              projectPlaceholder ??
              translate('auto.components.NewWorkspaceComposerCard.dccd26d4e4', 'Choose project')
            }
            triggerClassName={PILL_FIELD_CLASS}
            compact
            invalid={Boolean(projectError)}
            describedBy={projectDescriptionId}
          />
        </div>
        {shouldShowRunTargetPicker ? (
          <div className="w-36 min-w-0 shrink">
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
              triggerClassName={PILL_FIELD_CLASS}
              compact
            />
          </div>
        ) : null}
        <div className="min-w-0" data-contextual-tour-target="workspace-creation-agent">
          <AgentCombobox
            agents={visibleQuickAgents}
            value={quickAgent}
            onValueChange={onQuickAgentChange}
            onOpenManageAgents={onOpenAgentSettings}
            defaultAgent={defaultTuiAgent}
            onSetDefault={handleSetDefaultAgent}
            allowNarrowTrigger
            triggerClassName="h-7 w-auto border-transparent bg-transparent text-muted-foreground shadow-none hover:bg-accent dark:bg-transparent"
            onTriggerEnter={createDisabled ? undefined : onCreate}
          />
        </div>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              aria-label={primaryActionLabel}
              disabled={createDisabled}
              onClick={() => void onCreate()}
              size="icon-sm"
            >
              {creating ? (
                <LoaderCircle className="size-4 animate-spin" />
              ) : (
                <ArrowUp className="size-4" />
              )}
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top" sideOffset={4}>
            <span className="flex items-center gap-1.5">
              {primaryActionLabel}
              <ShortcutKeyCombo keys={[submitShortcutModifierLabel, '↵']} />
            </span>
          </TooltipContent>
        </Tooltip>
      </div>
    </>
  )
}
