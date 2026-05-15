import React from 'react'
import { Info, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
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
import { CreateFromPicker } from './CreateFromPicker'
import { WorkspaceCombobox } from './WorkspaceCombobox'

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
  missedRunGraceMinutes: string
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
  onSave: () => void
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
  onSave
}: AutomationEditorDialogProps): React.JSX.Element {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-lg"
        onOpenAutoFocus={(event) => {
          event.preventDefault()
        }}
      >
        <DialogHeader className="gap-1">
          <DialogTitle className="text-base font-semibold">
            {isEditing ? 'Edit Automation' : 'Create Automation'}
          </DialogTitle>
        </DialogHeader>
        <div className="grid gap-3">
          <Field label="Name">
            <Input
              value={draft.name}
              placeholder="Weekday repo audit"
              onChange={(event) =>
                onDraftChange((current) => ({ ...current, name: event.target.value }))
              }
            />
          </Field>
          <Field label="Project">
            <RepoCombobox
              repos={repos}
              value={draft.projectId}
              onValueChange={onProjectChange}
              placeholder="Select project"
              triggerClassName="h-9 w-full min-w-0"
              showStandaloneAddButton={false}
            />
          </Field>
          <Field label="Run location">
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
              className="grid w-full grid-cols-2"
            >
              <ToggleGroupItem value="existing" className="w-full">
                Selected workspace
              </ToggleGroupItem>
              <ToggleGroupItem value="new_per_run" className="w-full">
                New workspace each run
              </ToggleGroupItem>
            </ToggleGroup>
          </Field>
          {draft.workspaceMode === 'existing' ? (
            <Field label="Workspace">
              <WorkspaceCombobox
                worktrees={worktrees}
                value={draft.workspaceId}
                onValueChange={(workspaceId) =>
                  onDraftChange((current) => ({ ...current, workspaceId }))
                }
              />
            </Field>
          ) : (
            <Field label="Create from">
              <CreateFromPicker
                repoId={draft.projectId}
                repoMap={repoMap}
                worktrees={worktrees}
                value={draft.baseBranch}
                onValueChange={(baseBranch) =>
                  onDraftChange((current) => ({ ...current, baseBranch }))
                }
              />
            </Field>
          )}
          <div className="grid grid-cols-2 gap-2">
            <Field label="Agent">
              <AgentCombobox
                agents={AGENT_CATALOG}
                value={draft.agentId}
                onValueChange={(agentId) =>
                  agentId && onDraftChange((current) => ({ ...current, agentId }))
                }
                defaultAgent={settings?.defaultTuiAgent ?? null}
                triggerClassName="h-9 w-full min-w-0"
              />
            </Field>
            <Field label="Schedule">
              <Select
                value={draft.preset}
                onValueChange={(preset) =>
                  onDraftChange((current) => ({
                    ...current,
                    preset: preset as AutomationSchedulePreset
                  }))
                }
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="hourly">Hourly</SelectItem>
                  <SelectItem value="daily">Daily</SelectItem>
                  <SelectItem value="weekdays">Weekdays</SelectItem>
                  <SelectItem value="weekly">Weekly</SelectItem>
                </SelectContent>
              </Select>
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Time">
              <Input
                type="time"
                value={draft.time}
                disabled={draft.preset === 'hourly'}
                onChange={(event) =>
                  onDraftChange((current) => ({ ...current, time: event.target.value }))
                }
              />
            </Field>
            <Field label="Day">
              <Select
                value={draft.dayOfWeek}
                disabled={draft.preset !== 'weekly'}
                onValueChange={(dayOfWeek) =>
                  onDraftChange((current) => ({ ...current, dayOfWeek }))
                }
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="0">Sunday</SelectItem>
                  <SelectItem value="1">Monday</SelectItem>
                  <SelectItem value="2">Tuesday</SelectItem>
                  <SelectItem value="3">Wednesday</SelectItem>
                  <SelectItem value="4">Thursday</SelectItem>
                  <SelectItem value="5">Friday</SelectItem>
                  <SelectItem value="6">Saturday</SelectItem>
                </SelectContent>
              </Select>
            </Field>
          </div>
          <Field
            label={
              <span className="inline-flex items-center gap-1">
                Missed-run grace
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
                    one missed occurrence when it becomes available within this window. Older missed
                    runs are skipped.
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
              <SelectTrigger className="w-full">
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
          <Field label="Prompt">
            <textarea
              value={draft.prompt}
              rows={5}
              placeholder="Run the weekly dependency audit and summarize risky changes."
              onChange={(event) =>
                onDraftChange((current) => ({ ...current, prompt: event.target.value }))
              }
              className="w-full resize-none rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 dark:bg-input/30"
            />
          </Field>
          <div className="flex justify-end gap-2 pt-1">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button onClick={onSave} disabled={isSaving || repos.length === 0 || !canSave}>
              {isEditing ? null : <Plus className="size-4" />}
              {isEditing ? 'Save Changes' : 'Save Automation'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
