import React from 'react'
import { Info, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import AgentCombobox from '@/components/agent/AgentCombobox'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import type { AutomationWorkspaceMode } from '../../../../shared/automations-types'
import type { GlobalSettings, Repo, Worktree } from '../../../../shared/types'
import type { AgentCatalogEntry } from '@/lib/agent-catalog'
import { Field } from './automation-page-parts'
import { AutomationMissedRunGraceField } from './AutomationMissedRunGraceField'
import { AutomationSessionField } from './AutomationSessionField'
import { CreateFromPicker } from './CreateFromPicker'
import { WorkspaceCombobox } from './WorkspaceCombobox'
import AutomationProjectCombobox from './AutomationProjectCombobox'
import type { AutomationDraft } from './AutomationEditorDialog'

type AutomationEditorDialogFooterProps = {
  isEditing: boolean
  isEditingExternal: boolean
  isHermesTarget: boolean
  isHermesCreate: boolean
  isSaving: boolean
  canSave: boolean
  repos: Repo[]
  repoMap: Map<string, Repo>
  worktrees: Worktree[]
  settings: GlobalSettings | null
  draft: AutomationDraft
  visibleAgents: AgentCatalogEntry[]
  scheduleField: React.ReactNode
  pickerTriggerClassName: string
  modeToggleItemClassName: string
  onProjectChange: (projectId: string) => void
  getRepoHostLabel?: (repo: Repo) => string | null | undefined
  onDraftChange: (updater: (current: AutomationDraft) => AutomationDraft) => void
  onOpenChange: (open: boolean) => void
  onSave: () => void
}

export function AutomationEditorDialogFooter({
  isEditing,
  isEditingExternal,
  isHermesTarget,
  isHermesCreate,
  isSaving,
  canSave,
  repos,
  repoMap,
  worktrees,
  settings,
  draft,
  visibleAgents,
  scheduleField,
  pickerTriggerClassName,
  modeToggleItemClassName,
  onProjectChange,
  getRepoHostLabel,
  onDraftChange,
  onOpenChange,
  onSave
}: AutomationEditorDialogFooterProps): React.JSX.Element {
  return (
    <div className="border-t border-border/50 px-5 py-4">
      <div className="grid gap-3 md:grid-cols-3 lg:grid-cols-4">
        <Field
          label={translate(
            'auto.components.automations.AutomationEditorDialog.02d351877e',
            'Project'
          )}
        >
          <AutomationProjectCombobox
            repos={repos}
            value={draft.projectId}
            onValueChange={onProjectChange}
            placeholder={translate(
              'auto.components.automations.AutomationEditorDialog.0d17f4ca8f',
              'Select project'
            )}
            triggerClassName={`h-9 w-full min-w-0 ${pickerTriggerClassName}`}
            getRepoHostLabel={getRepoHostLabel}
          />
        </Field>
        <Field
          label={
            <span className="inline-flex items-center gap-1">
              {translate(
                'auto.components.automations.AutomationEditorDialog.b28b140eaf',
                'Workspace'
              )}
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    aria-label={translate(
                      'auto.components.automations.AutomationEditorDialog.2c3fd9bfa1',
                      'Workspace mode help'
                    )}
                    className="rounded-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
                  >
                    <Info className="size-3.5" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="top" sideOffset={6} className="max-w-72">
                  {translate(
                    'auto.components.automations.AutomationEditorDialog.6f9610e667',
                    'Worktree runs in the selected workspace. New run creates a fresh workspace from the selected branch each time.'
                  )}
                </TooltipContent>
              </Tooltip>
            </span>
          }
          className={isHermesTarget ? undefined : 'sm:col-span-2 lg:col-span-3'}
        >
          {isHermesTarget ? (
            <WorkspaceCombobox
              worktrees={worktrees}
              value={draft.workspaceId}
              triggerClassName={pickerTriggerClassName}
              onValueChange={(workspaceId) =>
                onDraftChange((current) => ({ ...current, workspaceId }))
              }
            />
          ) : (
            <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
              <ToggleGroup
                type="single"
                value={draft.workspaceMode}
                onValueChange={(workspaceMode) =>
                  workspaceMode &&
                  onDraftChange((current) => ({
                    ...current,
                    workspaceMode: workspaceMode as AutomationWorkspaceMode,
                    reuseSession: workspaceMode === 'existing' ? current.reuseSession : false
                  }))
                }
                variant="outline"
                size="sm"
                className="grid w-full grid-cols-2"
              >
                <ToggleGroupItem value="existing" className={modeToggleItemClassName}>
                  {translate(
                    'auto.components.automations.AutomationEditorDialog.a2e688226d',
                    'Worktree'
                  )}
                </ToggleGroupItem>
                <ToggleGroupItem value="new_per_run" className={modeToggleItemClassName}>
                  {translate(
                    'auto.components.automations.AutomationEditorDialog.6ff66f9012',
                    'New run'
                  )}
                </ToggleGroupItem>
              </ToggleGroup>
              {draft.workspaceMode === 'existing' ? (
                <WorkspaceCombobox
                  worktrees={worktrees}
                  value={draft.workspaceId}
                  triggerClassName={`min-w-0 ${pickerTriggerClassName}`}
                  onValueChange={(workspaceId) =>
                    onDraftChange((current) => ({ ...current, workspaceId }))
                  }
                />
              ) : (
                <CreateFromPicker
                  // Why: branch search state belongs to the selected project,
                  // so repo switches should reset it before the next paint.
                  key={draft.projectId}
                  repoId={draft.projectId}
                  repoMap={repoMap}
                  worktrees={worktrees}
                  value={draft.baseBranch}
                  triggerClassName={`min-w-0 ${pickerTriggerClassName}`}
                  onValueChange={(baseBranch) =>
                    onDraftChange((current) => ({ ...current, baseBranch }))
                  }
                />
              )}
            </div>
          )}
        </Field>
        {isHermesTarget ? scheduleField : null}
      </div>

      {/* Why: Hermes uses one compact footer row, while Orca adds agent,
          session, schedule, and missed-run controls. Animate that row so
          switching the target changes the dialog height smoothly. */}
      <div
        className={cn(
          'grid overflow-hidden transition-[grid-template-rows] duration-200 ease-out',
          isHermesTarget ? 'grid-rows-[0fr]' : 'grid-rows-[1fr]'
        )}
        aria-hidden={isHermesTarget}
        inert={isHermesTarget}
      >
        <div className="min-h-0">
          <div
            className={cn(
              'grid gap-3 pt-3 transition-[opacity,transform] duration-150 ease-out sm:grid-cols-2 lg:grid-cols-4',
              isHermesTarget
                ? '-translate-y-1 opacity-0 delay-0'
                : 'translate-y-0 opacity-100 delay-200'
            )}
          >
            <Field
              label={translate(
                'auto.components.automations.AutomationEditorDialog.57b722cbba',
                'Agent'
              )}
            >
              <AgentCombobox
                agents={visibleAgents}
                value={draft.agentId}
                onValueChange={(agentId) =>
                  agentId && onDraftChange((current) => ({ ...current, agentId }))
                }
                defaultAgent={settings?.defaultTuiAgent ?? null}
                triggerClassName={`h-9 w-full min-w-0 ${pickerTriggerClassName}`}
                allowNarrowTrigger
              />
            </Field>
            <AutomationSessionField
              draft={draft}
              toggleItemClassName={modeToggleItemClassName}
              onDraftChange={onDraftChange}
            />
            {isHermesTarget ? null : scheduleField}
            <AutomationMissedRunGraceField
              draft={draft}
              disabled={isHermesTarget}
              pickerTriggerClassName={pickerTriggerClassName}
              onDraftChange={onDraftChange}
            />
          </div>
        </div>
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="outline" onClick={() => onOpenChange(false)}>
          {translate('auto.components.automations.AutomationEditorDialog.fb1896a5e7', 'Cancel')}
        </Button>
        <Button
          variant="outline"
          onClick={onSave}
          disabled={isSaving || repos.length === 0 || !canSave}
          className="border-foreground/25 bg-foreground/[0.04] text-foreground hover:bg-foreground/[0.08]"
        >
          {isEditing || isEditingExternal || isHermesCreate || isSaving ? null : (
            <Plus className="size-4" />
          )}
          {isEditing || isEditingExternal
            ? translate(
                'auto.components.automations.AutomationEditorDialog.777548c2d6',
                'Save Changes'
              )
            : isSaving || isHermesCreate
              ? translate('auto.components.automations.AutomationEditorDialog.a9d9dccf77', 'Save')
              : translate(
                  'auto.components.automations.AutomationEditorDialog.e46c1aa9ad',
                  'Create'
                )}
        </Button>
      </div>
    </div>
  )
}
