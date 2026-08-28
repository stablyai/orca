import React from 'react'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { getAgentCatalog } from '@/lib/agent-catalog'
import { filterEnabledTuiAgents } from '../../../../shared/tui-agent-selection'
import type {
  AutomationSchedulePreset,
  AutomationWorkspaceMode
} from '../../../../shared/automations-types'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { OrcaHooks } from '../../../../shared/orca-yaml-hook-types'
import type { ProjectHostSetup } from '../../../../shared/project-types'
import type { Repo } from '../../../../shared/repo-types'
import type { TuiAgent } from '../../../../shared/tui-agent'
import type { SetupDecision } from '../../../../shared/worktree/create-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { closeUnfocusedMonacoFindOrPreventDialogDismiss } from '@/components/editor/monaco-find-widget'
import { AutomationOwnerConflictNotice } from './AutomationOwnerConflictNotice'
import type { AutomationActionNotice } from './automation-row-action-dispatch'
import type { AutomationHostRecoveryAction } from './automation-host-status-descriptors'
import type { AutomationCreateDestinationControl } from './use-automation-create-destination'
import { AutomationEditorDialogFooter } from './AutomationEditorDialogFooter'
import { AutomationEditorDialogHeader } from './AutomationEditorDialogHeader'
import { getAutomationPromptEditorRoot } from './AutomationEditorPromptEditor'
import { AutomationEditorPromptSection } from './AutomationEditorPromptSection'
import { AutomationEditorSettingsSidebar } from './AutomationEditorSettingsSidebar'
import { getAutomationTemplates, type AutomationTemplate } from './automation-templates'

export const AUTOMATION_EDITOR_PICKER_TRIGGER_CLASS =
  'border-input bg-input/30 shadow-xs hover:bg-accent/60 dark:bg-input/30 dark:hover:bg-input/50'

export const AUTOMATION_EDITOR_SEGMENTED_GROUP_CLASS =
  'grid w-full grid-cols-2 rounded-md bg-muted p-0.5'

export const AUTOMATION_EDITOR_SEGMENTED_ITEM_CLASS =
  'h-7 rounded-sm border-0 bg-transparent shadow-none hover:bg-card/70 data-[state=on]:bg-card data-[state=on]:text-card-foreground data-[state=on]:shadow-xs'

export type AutomationDraft = {
  name: string
  prompt: string
  agentId: TuiAgent
  projectId: string
  workspaceMode: AutomationWorkspaceMode
  workspaceId: string
  baseBranch: string
  setupDecision?: Extract<SetupDecision, 'run' | 'skip'>
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
  repos: readonly Repo[]
  projectHostSetups: readonly ProjectHostSetup[]
  automationYamlHooksByRepoKey: Record<string, OrcaHooks | null>
  getAutomationHooksCacheKey: (repoId: string) => string
  repoMap: Map<string, Repo>
  worktrees: Worktree[]
  settings: GlobalSettings | null
  draft: AutomationDraft
  /** Present only while creating an Orca automation. */
  createDestination?: AutomationCreateDestinationControl
  /** Present only while editing an Orca automation; selecting another host moves the record. */
  editDestination?: AutomationCreateDestinationControl
  /** Why a save was refused. Belongs here rather than on the page: this dialog covers it. */
  notice?: AutomationActionNotice | null
  onNoticeRecover?: (action: AutomationHostRecoveryAction) => void
  onNoticeDismiss?: () => void
  onProjectChange: (projectId: string) => void
  getRepoHostLabel?: (repo: Repo) => string | null | undefined
  allowAddProject?: boolean
  onCreateTargetChange: (target: AutomationCreateTarget) => void
  onOpenChange: (open: boolean) => void
  onDraftChange: (updater: (current: AutomationDraft) => AutomationDraft) => void
  onSetupDecisionTouched: () => void
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
  projectHostSetups,
  automationYamlHooksByRepoKey,
  getAutomationHooksCacheKey,
  repoMap,
  worktrees,
  settings,
  draft,
  createDestination,
  editDestination,
  notice,
  onNoticeRecover,
  onNoticeDismiss,
  onProjectChange,
  getRepoHostLabel,
  allowAddProject,
  onCreateTargetChange,
  onOpenChange,
  onDraftChange,
  onSetupDecisionTouched,
  onApplyTemplate,
  onSave
}: AutomationEditorDialogProps): React.JSX.Element {
  const [templateOpen, setTemplateOpen] = React.useState(false)
  const dialogContentRef = React.useRef<HTMLDivElement>(null)
  const isHermesTarget = createTarget === 'hermes'
  const isCreateMode = !isEditing && !isEditingExternal
  const isHermesCreate = isCreateMode && isHermesTarget
  const destination = isCreateMode ? createDestination : editDestination
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

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="flex h-[min(880px,90vh)] w-[min(1080px,calc(100vw-2rem))] max-w-[calc(100vw-2rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-[1080px]"
        aria-describedby={undefined}
        ref={dialogContentRef}
        onOpenAutoFocus={(event) => {
          event.preventDefault()
        }}
        onEscapeKeyDown={(event) => {
          // Why: Radix listens on document, so currentTarget is not the
          // dialog. Use the content ref to scope find to this prompt editor.
          const dialog =
            dialogContentRef.current ??
            (event.target instanceof Element
              ? event.target.closest('[data-slot="dialog-content"]')
              : null)
          if (
            closeUnfocusedMonacoFindOrPreventDialogDismiss({
              root: getAutomationPromptEditorRoot(dialog),
              eventTarget: event.target
            })
          ) {
            event.preventDefault()
          }
        }}
      >
        <AutomationEditorDialogHeader
          isEditing={isEditing}
          isEditingExternal={isEditingExternal}
          isHermesCreate={isHermesCreate}
          isCreateMode={isCreateMode}
          createTarget={createTarget}
          templateOpen={templateOpen}
          templates={getAutomationTemplates()}
          segmentedGroupClassName={AUTOMATION_EDITOR_SEGMENTED_GROUP_CLASS}
          segmentedItemClassName={AUTOMATION_EDITOR_SEGMENTED_ITEM_CLASS}
          onCreateTargetChange={onCreateTargetChange}
          onTemplateOpenChange={setTemplateOpen}
          onApplyTemplate={(template) => {
            onApplyTemplate(template)
            setTemplateOpen(false)
          }}
        />

        <div className="flex min-h-0 flex-1 flex-row">
          <AutomationEditorPromptSection
            draft={draft}
            onDraftChange={onDraftChange}
            onDismiss={() => onOpenChange(false)}
          />
          <AutomationEditorSettingsSidebar
            destination={destination}
            isHermesTarget={isHermesTarget}
            isHermesCreate={isHermesCreate}
            repos={repos}
            projectHostSetups={projectHostSetups}
            automationYamlHooksByRepoKey={automationYamlHooksByRepoKey}
            getAutomationHooksCacheKey={getAutomationHooksCacheKey}
            repoMap={repoMap}
            worktrees={worktrees}
            settings={settings}
            draft={draft}
            visibleAgents={visibleAgents}
            pickerTriggerClassName={AUTOMATION_EDITOR_PICKER_TRIGGER_CLASS}
            segmentedGroupClassName={AUTOMATION_EDITOR_SEGMENTED_GROUP_CLASS}
            segmentedItemClassName={AUTOMATION_EDITOR_SEGMENTED_ITEM_CLASS}
            onProjectChange={onProjectChange}
            getRepoHostLabel={getRepoHostLabel}
            allowAddProject={allowAddProject}
            onDraftChange={onDraftChange}
            onSetupDecisionTouched={onSetupDecisionTouched}
          />
        </div>

        <AutomationOwnerConflictNotice
          notice={notice ?? null}
          className="mx-5 mb-1"
          onRecover={onNoticeRecover}
          onDismiss={onNoticeDismiss}
        />

        <AutomationEditorDialogFooter
          isEditing={isEditing}
          isEditingExternal={isEditingExternal}
          isHermesCreate={isHermesCreate}
          isSaving={isSaving}
          canSave={canSave}
          hasProjects={repos.length > 0}
          onOpenChange={onOpenChange}
          onSave={onSave}
        />
      </DialogContent>
    </Dialog>
  )
}
