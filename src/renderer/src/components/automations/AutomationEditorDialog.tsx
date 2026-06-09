import React from 'react'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { getAgentCatalog } from '@/lib/agent-catalog'
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
import { AutomationEditorDialogFooter } from './AutomationEditorDialogFooter'
import { AutomationEditorDialogHeader } from './AutomationEditorDialogHeader'
import { AutomationEditorPromptSection } from './AutomationEditorPromptSection'
import { AutomationSchedulePicker } from './AutomationSchedulePicker'
import { getAutomationTemplates, type AutomationTemplate } from './automation-templates'
import { translate } from '@/i18n/i18n'

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
        getAgentCatalog().map((agent) => agent.id),
        settings?.disabledTuiAgents
      )
    )
    return getAgentCatalog().filter(
      (agent) => enabledIds.has(agent.id) || agent.id === draft.agentId
    )
  }, [draft.agentId, settings?.disabledTuiAgents])
  const scheduleField = (
    <Field
      label={translate('auto.components.automations.AutomationEditorDialog.c4b19094c2', 'Schedule')}
    >
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
          templates={getAutomationTemplates()}
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

        <AutomationEditorPromptSection
          draft={draft}
          isHermesCreate={isHermesCreate}
          pickerTriggerClassName={PICKER_TRIGGER_CLASS}
          onDraftChange={onDraftChange}
        />

        <AutomationEditorDialogFooter
          isEditing={isEditing}
          isEditingExternal={isEditingExternal}
          isHermesTarget={isHermesTarget}
          isHermesCreate={isHermesCreate}
          isSaving={isSaving}
          canSave={canSave}
          repos={repos}
          repoMap={repoMap}
          worktrees={worktrees}
          settings={settings}
          draft={draft}
          visibleAgents={visibleAgents}
          scheduleField={scheduleField}
          pickerTriggerClassName={PICKER_TRIGGER_CLASS}
          modeToggleItemClassName={MODE_TOGGLE_ITEM_CLASS}
          onProjectChange={onProjectChange}
          onDraftChange={onDraftChange}
          onOpenChange={onOpenChange}
          onSave={onSave}
        />
      </DialogContent>
    </Dialog>
  )
}
