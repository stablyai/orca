import AgentCombobox from '@/components/agent/AgentCombobox'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import {
  isValidAutomationCronSchedule,
  isValidAutomationSchedule
} from '../../../../shared/automation-schedules'
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
import type { AutomationDraft } from './AutomationEditorDialog'

type AutomationEditorSettingsSidebarProps = {
  isHermesTarget: boolean
  isHermesCreate: boolean
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
  onDraftChange: (updater: (current: AutomationDraft) => AutomationDraft) => void
  onSetupDecisionTouched: () => void
}

export function AutomationEditorSettingsSidebar({
  isHermesTarget,
  isHermesCreate,
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
  onDraftChange,
  onSetupDecisionTouched
}: AutomationEditorSettingsSidebarProps): React.JSX.Element {
  return (
    <aside className="flex w-[320px] shrink-0 flex-col overflow-auto border-l border-border/50 bg-muted/20 px-5 py-5 scrollbar-sleek">
      <div className="flex flex-col">
        {/* Why: Hermes keeps project/workspace/schedule only. Collapse the
            Orca-only knobs so switching the create target does not jump. */}
        <div
          className={cn(
            'grid overflow-hidden transition-[grid-template-rows,margin] duration-200 ease-out',
            isHermesTarget ? 'mb-0 grid-rows-[0fr]' : 'mb-4 grid-rows-[1fr]'
          )}
          aria-hidden={isHermesTarget}
          inert={isHermesTarget}
        >
          <div className="min-h-0">
            <div
              className={cn(
                'flex flex-col gap-5 transition-[opacity,transform] duration-150 ease-out',
                isHermesTarget
                  ? '-translate-y-1 opacity-0 delay-0'
                  : 'translate-y-0 opacity-100 delay-200'
              )}
            >
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
                  onValueChange={(agentId) =>
                    agentId && onDraftChange((current) => ({ ...current, agentId }))
                  }
                  defaultAgent={settings?.defaultTuiAgent ?? null}
                  triggerClassName={`h-9 w-full min-w-0 ${pickerTriggerClassName}`}
                  allowNarrowTrigger
                />
              </Field>
            </div>
          </div>
        </div>
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
        <div className="mb-4">
          <AutomationWorkspaceField
            draft={draft}
            isHermesTarget={isHermesTarget}
            worktrees={worktrees}
            repoMap={repoMap}
            pickerTriggerClassName={pickerTriggerClassName}
            segmentedGroupClassName={segmentedGroupClassName}
            segmentedItemClassName={segmentedItemClassName}
            onDraftChange={onDraftChange}
          />
        </div>
        <div
          className={cn(
            'grid overflow-hidden transition-[grid-template-rows,margin] duration-200 ease-out',
            isHermesTarget ? 'mb-0 grid-rows-[0fr]' : 'mb-4 grid-rows-[1fr]'
          )}
          aria-hidden={isHermesTarget}
          inert={isHermesTarget}
        >
          <div className="min-h-0">
            <AutomationSessionField
              draft={draft}
              toggleGroupClassName={segmentedGroupClassName}
              toggleItemClassName={segmentedItemClassName}
              onDraftChange={onDraftChange}
            />
          </div>
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
            validateAdvancedSchedule={
              isHermesTarget ? isValidAutomationCronSchedule : isValidAutomationSchedule
            }
            onDraftChange={onDraftChange}
          />
        </Field>
        <div
          className={cn(
            'grid overflow-hidden transition-[grid-template-rows,margin] duration-200 ease-out',
            isHermesTarget ? 'mb-0 grid-rows-[0fr]' : 'mb-4 grid-rows-[1fr]'
          )}
          aria-hidden={isHermesTarget}
          inert={isHermesTarget}
        >
          <div className="min-h-0">
            <AutomationMissedRunGraceField
              draft={draft}
              disabled={isHermesTarget}
              pickerTriggerClassName={pickerTriggerClassName}
              onDraftChange={onDraftChange}
            />
          </div>
        </div>
        <div
          className={cn(
            'grid overflow-hidden transition-[grid-template-rows,margin] duration-200 ease-out',
            isHermesCreate ? 'mb-0 grid-rows-[0fr]' : 'mb-4 grid-rows-[1fr]'
          )}
          aria-hidden={isHermesCreate}
          inert={isHermesCreate}
        >
          <div className="min-h-0">
            <div className="flex flex-col gap-5">
              <AutomationPrecheckFields
                draft={draft}
                disabled={isHermesCreate}
                pickerTriggerClassName={pickerTriggerClassName}
                onDraftChange={onDraftChange}
              />
            </div>
          </div>
        </div>
        <AutomationSetupDecisionField
          createTarget={isHermesTarget ? 'hermes' : 'orca'}
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
