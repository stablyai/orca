import React from 'react'
import { Info, Plus, Sparkles } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import AgentCombobox from '@/components/agent/AgentCombobox'
import RepoCombobox from '@/components/repo/RepoCombobox'
import { AGENT_CATALOG } from '@/lib/agent-catalog'
import type {
  AutomationSchedulePreset,
  AutomationWorkspaceMode
} from '../../../../shared/automations-types'
import type { GlobalSettings, Repo, TuiAgent, Worktree } from '../../../../shared/types'
import { Field } from './automation-page-parts'
import { AutomationSchedulePicker } from './AutomationSchedulePicker'
import { AUTOMATION_TEMPLATES, type AutomationTemplate } from './automation-templates'
import { CreateFromPicker } from './CreateFromPicker'
import { WorkspaceCombobox } from './WorkspaceCombobox'

const PICKER_TRIGGER_CLASS =
  'border-input bg-input/30 shadow-xs hover:bg-accent/60 dark:bg-input/30 dark:hover:bg-input/50'

export type AutomationDraft = {
  name: string
  prompt: string
  agentId: TuiAgent
  projectId: string
  workspaceMode: AutomationWorkspaceMode
  workspaceId: string
  baseBranch: string
  preset: AutomationSchedulePreset
  time: string
  dayOfWeek: string
  customSchedule: string
  missedRunGraceMinutes: string
  scheduleWarning: string | null
}

type AutomationEditorDialogProps = {
  open: boolean
  isEditing: boolean
  isSaving: boolean
  canSave: boolean
  repos: Repo[]
  repoMap: Map<string, Repo>
  worktrees: Worktree[]
  settings: GlobalSettings | null
  draft: AutomationDraft
  onProjectChange: (projectId: string) => void
  onOpenChange: (open: boolean) => void
  onDraftChange: (updater: (current: AutomationDraft) => AutomationDraft) => void
  onApplyTemplate: (template: AutomationTemplate) => void
  onSave: () => void
}

function AutomationTemplateCard({
  template,
  onSelect
}: {
  template: AutomationTemplate
  onSelect: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onSelect}
      className="rounded-md border border-border/70 bg-background px-3 py-2 text-left shadow-xs transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
    >
      <div className="text-[11px] font-medium uppercase text-muted-foreground">
        {template.category}
      </div>
      <div className="mt-1 text-sm font-medium">{template.label}</div>
      <div className="mt-1 line-clamp-2 text-xs text-muted-foreground">{template.description}</div>
    </button>
  )
}

export function AutomationEditorDialog({
  open,
  isEditing,
  isSaving,
  canSave,
  repos,
  repoMap,
  worktrees,
  settings,
  draft,
  onProjectChange,
  onOpenChange,
  onDraftChange,
  onApplyTemplate,
  onSave
}: AutomationEditorDialogProps): React.JSX.Element {
  const [templateOpen, setTemplateOpen] = React.useState(false)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="flex max-h-[90vh] flex-col gap-0 p-0 sm:max-w-[920px]"
        onOpenAutoFocus={(event) => {
          event.preventDefault()
        }}
      >
        <DialogHeader className="border-b border-border/50 px-5 py-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1 space-y-2">
              <DialogTitle className="text-sm font-medium">
                {isEditing ? 'Edit automation' : 'Create automation'}
              </DialogTitle>
              <Input
                value={draft.name}
                placeholder="Weekday repo audit"
                aria-label="Automation name"
                className="h-10 border-0 bg-transparent px-0 text-lg font-semibold shadow-none focus-visible:ring-0"
                onChange={(event) =>
                  onDraftChange((current) => ({ ...current, name: event.target.value }))
                }
              />
            </div>
            {!isEditing ? (
              <Popover open={templateOpen} onOpenChange={setTemplateOpen}>
                <PopoverTrigger asChild>
                  <Button type="button" variant="outline" size="sm">
                    <Sparkles className="size-4" />
                    Use template
                  </Button>
                </PopoverTrigger>
                <PopoverContent align="end" className="w-96 p-3">
                  <div className="grid gap-2">
                    {AUTOMATION_TEMPLATES.map((template) => (
                      <AutomationTemplateCard
                        key={template.id}
                        template={template}
                        onSelect={() => {
                          onApplyTemplate(template)
                          setTemplateOpen(false)
                        }}
                      />
                    ))}
                  </div>
                </PopoverContent>
              </Popover>
            ) : null}
          </div>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-auto px-5 py-4">
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
          </Field>
        </div>

        <div className="border-t border-border/50 px-5 py-4">
          <div className="grid gap-3 lg:grid-cols-[minmax(9rem,1.1fr)_minmax(14rem,1.4fr)_minmax(12rem,1.2fr)_minmax(8rem,0.8fr)_minmax(9rem,1fr)]">
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
            <Field label={draft.workspaceMode === 'new_per_run' ? 'Start branch' : 'Workspace'}>
              <ToggleGroup
                type="single"
                value={draft.workspaceMode}
                onValueChange={(workspaceMode) =>
                  workspaceMode &&
                  onDraftChange((current) => ({
                    ...current,
                    workspaceMode: workspaceMode as AutomationWorkspaceMode
                  }))
                }
                variant="outline"
                size="sm"
                className="mb-2 grid w-full grid-cols-2"
              >
                <ToggleGroupItem
                  value="existing"
                  className="w-full border-input bg-input/30 shadow-xs data-[state=on]:border-primary data-[state=on]:bg-primary data-[state=on]:text-primary-foreground dark:bg-input/30"
                >
                  Workspace
                </ToggleGroupItem>
                <ToggleGroupItem
                  value="new_per_run"
                  className="w-full border-input bg-input/30 shadow-xs data-[state=on]:border-primary data-[state=on]:bg-primary data-[state=on]:text-primary-foreground dark:bg-input/30"
                >
                  New run
                </ToggleGroupItem>
              </ToggleGroup>
              {draft.workspaceMode === 'existing' ? (
                <WorkspaceCombobox
                  worktrees={worktrees}
                  value={draft.workspaceId}
                  triggerClassName={PICKER_TRIGGER_CLASS}
                  onValueChange={(workspaceId) =>
                    onDraftChange((current) => ({ ...current, workspaceId }))
                  }
                />
              ) : (
                <CreateFromPicker
                  repoId={draft.projectId}
                  repoMap={repoMap}
                  worktrees={worktrees}
                  value={draft.baseBranch}
                  triggerClassName={PICKER_TRIGGER_CLASS}
                  onValueChange={(baseBranch) =>
                    onDraftChange((current) => ({ ...current, baseBranch }))
                  }
                />
              )}
            </Field>
            <Field label="Agent">
              <AgentCombobox
                agents={AGENT_CATALOG}
                value={draft.agentId}
                onValueChange={(agentId) =>
                  agentId && onDraftChange((current) => ({ ...current, agentId }))
                }
                defaultAgent={settings?.defaultTuiAgent ?? null}
                triggerClassName={`h-9 w-full min-w-0 ${PICKER_TRIGGER_CLASS}`}
              />
            </Field>
            <Field label="Schedule">
              <AutomationSchedulePicker
                draft={draft}
                triggerClassName={PICKER_TRIGGER_CLASS}
                onDraftChange={onDraftChange}
              />
            </Field>
            <Field
              label={
                <span className="inline-flex items-center gap-1">
                  Grace
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        aria-label="Missed-run grace help"
                        className="rounded-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
                      >
                        <Info className="size-3.5" />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="top" sideOffset={6} className="max-w-72">
                      If Orca or the execution host was unavailable at the scheduled time, Orca runs
                      one missed occurrence when it becomes available within this window. Older
                      missed runs are skipped.
                    </TooltipContent>
                  </Tooltip>
                </span>
              }
            >
              <Select
                value={draft.missedRunGraceMinutes}
                onValueChange={(missedRunGraceMinutes) =>
                  onDraftChange((current) => ({ ...current, missedRunGraceMinutes }))
                }
              >
                <SelectTrigger className={`w-full ${PICKER_TRIGGER_CLASS}`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent position="popper" side="bottom" align="start" sideOffset={4}>
                  <SelectItem value="0">No grace</SelectItem>
                  <SelectItem value="30">30 minutes</SelectItem>
                  <SelectItem value="60">1 hour</SelectItem>
                  <SelectItem value="180">3 hours</SelectItem>
                  <SelectItem value="720">12 hours</SelectItem>
                  <SelectItem value="1440">24 hours</SelectItem>
                  <SelectItem value="2880">48 hours</SelectItem>
                </SelectContent>
              </Select>
            </Field>
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
              {isEditing ? null : <Plus className="size-4" />}
              {isEditing ? 'Save Changes' : 'Save Automation'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
