import React from 'react'
import { Info, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import AgentCombobox from '@/components/agent/AgentCombobox'
import RepoCombobox from '@/components/repo/RepoCombobox'
import { AGENT_CATALOG } from '@/lib/agent-catalog'
import { cn } from '@/lib/utils'
import { filterEnabledTuiAgents } from '../../../../shared/tui-agent-selection'
import type {
  AutomationSchedulePreset,
  AutomationWorkspaceMode
} from '../../../../shared/automations-types'
import type { GlobalSettings, Repo, TuiAgent, Worktree } from '../../../../shared/types'
import {
  isValidAutomationCronSchedule,
  isValidAutomationSchedule
} from '../../../../shared/automation-schedules'
import { Field } from './automation-page-parts'
import { AutomationEditorDialogHeader } from './AutomationEditorDialogHeader'
import { AutomationMissedRunGraceField } from './AutomationMissedRunGraceField'
import { AutomationPrecheckFields } from './AutomationPrecheckFields'
import { AutomationSchedulePicker } from './AutomationSchedulePicker'
import { AutomationSessionField } from './AutomationSessionField'
import { AUTOMATION_TEMPLATES, type AutomationTemplate } from './automation-templates'
import { CreateFromPicker } from './CreateFromPicker'
import { WorkspaceCombobox } from './WorkspaceCombobox'

const PICKER_TRIGGER_CLASS =
  'border-input bg-input/30 shadow-xs hover:bg-accent/60 dark:bg-input/30 dark:hover:bg-input/50'
const MODE_TOGGLE_ITEM_CLASS =
  'w-full border-input bg-input/30 shadow-xs hover:bg-accent/60 data-[state=on]:border-primary data-[state=on]:bg-primary data-[state=on]:text-primary-foreground data-[state=on]:hover:bg-primary/90 dark:bg-input/30 dark:data-[state=on]:bg-primary dark:data-[state=on]:text-primary-foreground dark:data-[state=on]:hover:bg-primary/90'

export type AutomationDraft = {
  name: string
  prompt: string
  agentId: TuiAgent
  projectId: string
  workspaceMode: AutomationWorkspaceMode
  workspaceId: string
  baseBranch: string
  reuseSession: boolean
  precheckCommand: string
  precheckTimeoutSeconds: string
  preset: AutomationSchedulePreset
  time: string
  dayOfWeek: string
  customSchedule: string
  missedRunGraceMinutes: string
  scheduleWarning: string | null
}

export type AutomationCreateTarget = 'orca' | 'hermes'

type AutomationEditorDialogProps = {
  open: boolean
  isEditing: boolean
  isEditingExternal: boolean
  isSaving: boolean
  canSave: boolean
  createTarget: AutomationCreateTarget
  repos: Repo[]
  repoMap: Map<string, Repo>
  worktrees: Worktree[]
  settings: GlobalSettings | null
  draft: AutomationDraft
  onProjectChange: (projectId: string) => void
  onCreateTargetChange: (target: AutomationCreateTarget) => void
  onOpenChange: (open: boolean) => void
  onDraftChange: (updater: (current: AutomationDraft) => AutomationDraft) => void
  onApplyTemplate: (template: AutomationTemplate) => void
  onSave: () => void
}

export function AutomationEditorDialog({
  open,
  isEditing,
  isEditingExternal,
  isSaving,
  canSave,
  createTarget,
  repos,
  repoMap,
  worktrees,
  settings,
  draft,
  onProjectChange,
  onCreateTargetChange,
  onOpenChange,
  onDraftChange,
  onApplyTemplate,
  onSave
}: AutomationEditorDialogProps): React.JSX.Element {
  const [templateOpen, setTemplateOpen] = React.useState(false)
  const isHermesTarget = createTarget === 'hermes'
  const isCreateMode = !isEditing && !isEditingExternal
  const isHermesCreate = isCreateMode && isHermesTarget
  const visibleAgents = React.useMemo(() => {
    const enabledIds = new Set(
      filterEnabledTuiAgents(
        AGENT_CATALOG.map((agent) => agent.id),
        settings?.disabledTuiAgents
      )
    )
    return AGENT_CATALOG.filter((agent) => enabledIds.has(agent.id) || agent.id === draft.agentId)
  }, [draft.agentId, settings?.disabledTuiAgents])
  const scheduleField = (
    <Field label="Schedule">
      <AutomationSchedulePicker
        draft={draft}
        triggerClassName={PICKER_TRIGGER_CLASS}
        validateAdvancedSchedule={
          isHermesTarget ? isValidAutomationCronSchedule : isValidAutomationSchedule
        }
        onDraftChange={onDraftChange}
      />
    </Field>
  )

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="flex max-h-[90vh] flex-col gap-0 p-0 dark:border-border dark:bg-card dark:text-card-foreground sm:max-w-[920px]"
        onOpenAutoFocus={(event) => {
          event.preventDefault()
        }}
      >
        <AutomationEditorDialogHeader
          isEditing={isEditing}
          isEditingExternal={isEditingExternal}
          isHermesCreate={isHermesCreate}
          isCreateMode={isCreateMode}
          createTarget={createTarget}
          draftName={draft.name}
          templateOpen={templateOpen}
          templates={AUTOMATION_TEMPLATES}
          modeToggleItemClassName={MODE_TOGGLE_ITEM_CLASS}
          pickerTriggerClassName={PICKER_TRIGGER_CLASS}
          onCreateTargetChange={onCreateTargetChange}
          onDraftNameChange={(name) => onDraftChange((current) => ({ ...current, name }))}
          onTemplateOpenChange={setTemplateOpen}
          onApplyTemplate={(template) => {
            onApplyTemplate(template)
            setTemplateOpen(false)
          }}
        />

        <div className="min-h-0 flex-1 overflow-auto px-5 py-4 scrollbar-sleek">
          {draft.scheduleWarning ? (
            <div className="mb-3 rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
              {draft.scheduleWarning}
            </div>
          ) : null}
          <Field label="Prompt">
            <textarea
              value={draft.prompt}
              placeholder="Run the weekly dependency audit and summarize risky changes."
              onChange={(event) =>
                onDraftChange((current) => ({ ...current, prompt: event.target.value }))
              }
              className="min-h-[260px] w-full resize-none rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 dark:bg-input/30"
            />
            <p className="mt-1 text-xs text-muted-foreground">
              Supports skills, file paths, and built-in commands like{' '}
              <code className="rounded bg-muted px-1 font-mono text-[11px]">/goal</code>.
            </p>
          </Field>
          {/* Why: the Orca/Hermes target toggle changes form height; collapsing the
              Orca-only precheck row keeps the dialog from snapping vertically. */}
          <div
            className={cn(
              'grid overflow-hidden transition-[grid-template-rows] duration-200 ease-out',
              isHermesCreate ? 'grid-rows-[0fr]' : 'grid-rows-[1fr]'
            )}
            aria-hidden={isHermesCreate}
            inert={isHermesCreate}
          >
            <div className="min-h-0">
              <div
                className={cn(
                  'mt-3 grid gap-3 transition-[opacity,transform] duration-150 ease-out sm:grid-cols-[minmax(0,1fr)_9rem]',
                  isHermesCreate
                    ? '-translate-y-1 opacity-0 delay-0'
                    : 'translate-y-0 opacity-100 delay-200'
                )}
              >
                <AutomationPrecheckFields
                  draft={draft}
                  disabled={isHermesCreate}
                  pickerTriggerClassName={PICKER_TRIGGER_CLASS}
                  onDraftChange={onDraftChange}
                />
              </div>
            </div>
          </div>
        </div>

        <div className="border-t border-border/50 px-5 py-4">
          <div className="grid gap-3 md:grid-cols-3 lg:grid-cols-4">
            <Field label="Project">
              <RepoCombobox
                repos={repos}
                value={draft.projectId}
                onValueChange={onProjectChange}
                placeholder="Select project"
                triggerClassName={`h-9 w-full min-w-0 ${PICKER_TRIGGER_CLASS}`}
                showStandaloneAddButton={false}
              />
            </Field>
            <Field
              label={
                <span className="inline-flex items-center gap-1">
                  Workspace
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        aria-label="Workspace mode help"
                        className="rounded-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
                      >
                        <Info className="size-3.5" />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="top" sideOffset={6} className="max-w-72">
                      Worktree runs in the selected workspace. New run creates a fresh workspace
                      from the selected branch each time.
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
                  triggerClassName={PICKER_TRIGGER_CLASS}
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
                    <ToggleGroupItem value="existing" className={MODE_TOGGLE_ITEM_CLASS}>
                      Worktree
                    </ToggleGroupItem>
                    <ToggleGroupItem value="new_per_run" className={MODE_TOGGLE_ITEM_CLASS}>
                      New run
                    </ToggleGroupItem>
                  </ToggleGroup>
                  {draft.workspaceMode === 'existing' ? (
                    <WorkspaceCombobox
                      worktrees={worktrees}
                      value={draft.workspaceId}
                      triggerClassName={`min-w-0 ${PICKER_TRIGGER_CLASS}`}
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
                      triggerClassName={`min-w-0 ${PICKER_TRIGGER_CLASS}`}
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
                <Field label="Agent">
                  <AgentCombobox
                    agents={visibleAgents}
                    value={draft.agentId}
                    onValueChange={(agentId) =>
                      agentId && onDraftChange((current) => ({ ...current, agentId }))
                    }
                    defaultAgent={settings?.defaultTuiAgent ?? null}
                    triggerClassName={`h-9 w-full min-w-0 ${PICKER_TRIGGER_CLASS}`}
                    allowNarrowTrigger
                  />
                </Field>
                <AutomationSessionField
                  draft={draft}
                  toggleItemClassName={MODE_TOGGLE_ITEM_CLASS}
                  onDraftChange={onDraftChange}
                />
                {isHermesTarget ? null : scheduleField}
                <AutomationMissedRunGraceField
                  draft={draft}
                  disabled={isHermesTarget}
                  pickerTriggerClassName={PICKER_TRIGGER_CLASS}
                  onDraftChange={onDraftChange}
                />
              </div>
            </div>
          </div>
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
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
                ? 'Save Changes'
                : isSaving || isHermesCreate
                  ? 'Save'
                  : 'Create'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
