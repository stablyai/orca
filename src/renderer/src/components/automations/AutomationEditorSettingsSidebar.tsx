import { AutomationSurfaceField } from './AutomationSurfaceField'
import AgentCombobox from '@/components/agent/AgentCombobox'
import { translate } from '@/i18n/i18n'
import { isValidAutomationSchedule } from '../../../../shared/automation-schedule-parsing'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { OrcaHooks } from '../../../../shared/orca-yaml-hook-types'
import type { ProjectHostSetup } from '../../../../shared/project-types'
import type { Repo } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'
import type { AgentCatalogEntry } from '@/lib/agent-catalog'
import { AUTOMATION_EDITOR_SECTION_LABEL_CLASS, Field } from './automation-page-parts'
import { AutomationMissedRunGraceField } from './AutomationMissedRunGraceField'
import { AutomationPrecheckFields } from './AutomationPrecheckFields'
import AutomationProjectCombobox from './AutomationProjectCombobox'
import { AutomationSchedulePicker } from './AutomationSchedulePicker'
import { AutomationSessionField } from './AutomationSessionField'
import { AutomationSetupDecisionField } from './AutomationSetupDecisionField'
import { AutomationWorkspaceField } from './AutomationWorkspaceField'
import { AutomationDestinationField } from './AutomationDestinationField'
import { AutomationExtraAgentArgsField } from './AutomationExtraAgentArgsField'
import type { AutomationCreateDestinationControl } from './use-automation-create-destination'
import type { AutomationDraft } from './AutomationEditorDialog'

type AutomationEditorSettingsSidebarProps = {
  /** The host picker: where a create lands, or the host an edit can move the record to. */
  surface: 'chat' | 'terminal'
  chatSupported: boolean | null
  destination?: AutomationCreateDestinationControl
  repos: readonly Repo[]
  projectHostSetups: readonly ProjectHostSetup[]
  automationYamlHooksByRepoKey: Record<string, OrcaHooks | null>
  getAutomationHooksCacheKey: (repoId: string) => string
  repoMap: Map<string, Repo>
  worktrees: Worktree[]
  settings: GlobalSettings | null
  draft: AutomationDraft
  visibleAgents: AgentCatalogEntry[]
  pickerTriggerClassName: string
  segmentedGroupClassName: string
  segmentedItemClassName: string
  onProjectChange: (projectId: string) => void
  getRepoHostLabel?: (repo: Repo) => string | null | undefined
  allowAddProject?: boolean
  onDraftChange: (updater: (current: AutomationDraft) => AutomationDraft) => void
  onSetupDecisionTouched: () => void
}

export function AutomationEditorSettingsSidebar({
  destination,
  surface,
  chatSupported,
  repos,
  projectHostSetups,
  automationYamlHooksByRepoKey,
  getAutomationHooksCacheKey,
  repoMap,
  worktrees,
  settings,
  draft,
  visibleAgents,
  pickerTriggerClassName,
  segmentedGroupClassName,
  segmentedItemClassName,
  onProjectChange,
  getRepoHostLabel,
  allowAddProject,
  onDraftChange,
  onSetupDecisionTouched
}: AutomationEditorSettingsSidebarProps): React.JSX.Element {
  return (
    <aside className="flex w-[320px] shrink-0 flex-col overflow-auto border-l border-border/50 bg-muted/20 px-5 py-5 scrollbar-sleek">
      <div className="flex flex-col">
        <div className="mb-4 flex flex-col gap-5">
          <Field
            labelClassName={AUTOMATION_EDITOR_SECTION_LABEL_CLASS}
            label={translate(
              'auto.components.automations.AutomationEditorDialog.57b722cbba',
              'Agent'
            )}
          >
            <AgentCombobox
              agents={visibleAgents}
              value={draft.agentId}
              onValueChange={(agentId) => onDraftChange((current) => ({ ...current, agentId }))}
              defaultAgent={settings?.defaultTuiAgent ?? null}
              triggerClassName={`h-9 w-full min-w-0 ${pickerTriggerClassName}`}
              allowNarrowTrigger
            />
          </Field>
          <AutomationSurfaceField
            draft={draft}
            settings={settings}
            supported={chatSupported}
            onDraftChange={onDraftChange}
          />
          {surface === 'terminal' ? (
            <AutomationExtraAgentArgsField draft={draft} onDraftChange={onDraftChange} />
          ) : null}
        </div>
        {destination ? (
          <div className="mb-4">
            <AutomationDestinationField
              control={destination}
              labelClassName={AUTOMATION_EDITOR_SECTION_LABEL_CLASS}
            />
          </div>
        ) : null}
        <Field
          className="mb-4"
          labelClassName={AUTOMATION_EDITOR_SECTION_LABEL_CLASS}
          label={translate(
            'auto.components.automations.AutomationEditorDialog.02d351877e',
            'Project'
          )}
        >
          <AutomationProjectCombobox
            repos={repos}
            recordedProject={destination?.recordedProject}
            value={draft.projectId}
            onValueChange={onProjectChange}
            placeholder={translate(
              'auto.components.automations.AutomationEditorDialog.0d17f4ca8f',
              'Select project'
            )}
            triggerClassName={`h-9 w-full min-w-0 ${pickerTriggerClassName}`}
            getRepoHostLabel={getRepoHostLabel}
            allowAddProject={allowAddProject}
          />
        </Field>
        <div className="mb-4">
          <AutomationWorkspaceField
            draft={draft}
            worktrees={worktrees}
            repoMap={repoMap}
            pickerTriggerClassName={pickerTriggerClassName}
            segmentedGroupClassName={segmentedGroupClassName}
            segmentedItemClassName={segmentedItemClassName}
            onDraftChange={onDraftChange}
          />
        </div>
        <div className="mb-4">
          <AutomationSessionField
            draft={draft}
            toggleGroupClassName={segmentedGroupClassName}
            toggleItemClassName={segmentedItemClassName}
            onDraftChange={onDraftChange}
          />
        </div>
        <Field
          className="mb-4"
          labelClassName={AUTOMATION_EDITOR_SECTION_LABEL_CLASS}
          label={translate(
            'auto.components.automations.AutomationEditorDialog.c4b19094c2',
            'Schedule'
          )}
        >
          <AutomationSchedulePicker
            draft={draft}
            validateAdvancedSchedule={isValidAutomationSchedule}
            onDraftChange={onDraftChange}
          />
        </Field>
        <div className="mb-4">
          <AutomationMissedRunGraceField
            disabled={false}
            draft={draft}
            pickerTriggerClassName={pickerTriggerClassName}
            onDraftChange={onDraftChange}
          />
        </div>
        <div className="mb-4">
          <div className="flex flex-col gap-5">
            <AutomationPrecheckFields
              disabled={false}
              draft={draft}
              pickerTriggerClassName={pickerTriggerClassName}
              onDraftChange={onDraftChange}
            />
          </div>
        </div>
        <AutomationSetupDecisionField
          draft={draft}
          repos={repos}
          projectHostSetups={projectHostSetups}
          yamlHooks={automationYamlHooksByRepoKey[getAutomationHooksCacheKey(draft.projectId)]}
          onDraftChange={onDraftChange}
          onSetupDecisionTouched={onSetupDecisionTouched}
        />
      </div>
    </aside>
  )
}
