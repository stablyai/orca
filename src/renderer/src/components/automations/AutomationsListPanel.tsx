import React from 'react'
import { Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type {
  Automation,
  AutomationRun,
  ExternalAutomationAction,
  ExternalAutomationJob,
  ExternalAutomationManager
} from '../../../../shared/automations-types'
import type { SshConnectionState } from '../../../../shared/ssh-types'
import type { ProjectHostSetup, Repo, Worktree } from '../../../../shared/types'
import type { RuntimeStatus } from '../../../../shared/runtime-types'
import type { TaskSourceHostAvailability } from '../task-source-context-summary'
import type { AutomationHostTarget } from './automation-host-client'
import { clampAutomationListSearchQueryInput } from './automation-list-search'
import type { AutomationPaneTab } from './automation-page-state'
import { AutomationListSearchField } from './AutomationListSearchField'
import { getAutomationTemplates, type AutomationTemplate } from './automation-templates'
import type { ExternalAutomationListEntry } from './external-automation-list-entries'
import { AutomationListLocalRows } from './AutomationListLocalRows'
import { AutomationListExternalRows } from './AutomationListExternalRows'
import { translate } from '@/i18n/i18n'

type AutomationsListPanelProps = {
  hasListItems: boolean
  hasFilteredListItems: boolean
  isListSearchActive: boolean
  listSearchQuery: string
  isListSearchQueryTooLarge: boolean
  onListSearchQueryChange: (query: string) => void
  filteredAutomations: readonly Automation[]
  filteredExternalAutomationEntries: readonly ExternalAutomationListEntry[]
  selected: Automation | null
  selectedExternal: ExternalAutomationListEntry | null
  runs: readonly AutomationRun[]
  relativeNow: number
  repoMap: ReadonlyMap<string, Repo>
  worktreeMap: ReadonlyMap<string, Worktree>
  projectHostSetups: readonly ProjectHostSetup[]
  sshConnectionStates: ReadonlyMap<string, Pick<SshConnectionState, 'status'>>
  runtimeStatusByEnvironmentId: ReadonlyMap<
    string,
    { status: RuntimeStatus | null; checkedAt: number }
  >
  automationHostTarget: AutomationHostTarget | null
  automationSourceHostAvailabilityById: ReadonlyMap<string, TaskSourceHostAvailability[]>
  externalActionKey: string | null
  selectAutomationId: (automationId: string | null) => void
  selectExternalKey: (externalKey: string | null) => void
  setActivePaneTab: (tab: AutomationPaneTab) => void
  runNow: (automation: Automation) => void
  openEditDialog: (automation: Automation) => void
  toggleAutomation: (automation: Automation) => void
  requestDeleteAutomation: (automation: Automation) => void
  requestExternalAction: (
    manager: ExternalAutomationManager,
    job: ExternalAutomationJob,
    action: ExternalAutomationAction
  ) => void
  openEditExternalDialog: (manager: ExternalAutomationManager, job: ExternalAutomationJob) => void
  openCreateDialog: (template?: AutomationTemplate) => void
}

export function AutomationsListPanel({
  hasListItems,
  hasFilteredListItems,
  isListSearchActive,
  listSearchQuery,
  isListSearchQueryTooLarge,
  onListSearchQueryChange,
  filteredAutomations,
  filteredExternalAutomationEntries,
  selected,
  selectedExternal,
  runs,
  relativeNow,
  repoMap,
  worktreeMap,
  projectHostSetups,
  sshConnectionStates,
  runtimeStatusByEnvironmentId,
  automationHostTarget,
  automationSourceHostAvailabilityById,
  externalActionKey,
  selectAutomationId,
  selectExternalKey,
  setActivePaneTab,
  runNow,
  openEditDialog,
  toggleAutomation,
  requestDeleteAutomation,
  requestExternalAction,
  openEditExternalDialog,
  openCreateDialog
}: AutomationsListPanelProps): React.JSX.Element {
  return (
    <section
      className="flex min-h-0 flex-col border-r border-border/50 bg-muted/20"
      data-contextual-tour-target="automations-list"
    >
      {hasListItems ? (
        <div className="shrink-0 border-b border-border/40 px-2 py-2">
          <AutomationListSearchField
            query={listSearchQuery}
            isTooLarge={isListSearchQueryTooLarge}
            onQueryChange={(query) =>
              onListSearchQueryChange(clampAutomationListSearchQueryInput(query))
            }
            onClear={() => onListSearchQueryChange('')}
          />
        </div>
      ) : null}
      <div className="scrollbar-sleek min-h-0 flex-1 overflow-auto p-2">
        {hasFilteredListItems ? (
          <div className="grid grid-cols-[1fr_auto] gap-2 px-2 pb-2 text-[11px] font-medium uppercase text-muted-foreground">
            <span>
              {translate('auto.components.automations.AutomationsPage.761a35834d', 'Automation')}
            </span>
            <span>
              {translate('auto.components.automations.AutomationsPage.587a4b205c', 'Next')}
            </span>
          </div>
        ) : null}
        <AutomationListLocalRows
          automations={filteredAutomations}
          selectedId={selected?.id}
          isSelectedLocal={selectedExternal === null}
          runs={runs}
          relativeNow={relativeNow}
          repoMap={repoMap}
          worktreeMap={worktreeMap}
          projectHostSetups={projectHostSetups}
          sshConnectionStates={sshConnectionStates}
          runtimeStatusByEnvironmentId={runtimeStatusByEnvironmentId}
          automationHostTarget={automationHostTarget}
          automationSourceHostAvailabilityById={automationSourceHostAvailabilityById}
          onSelect={(automationId) => {
            selectExternalKey(null)
            selectAutomationId(automationId)
          }}
          onRunNow={runNow}
          onEdit={openEditDialog}
          onToggle={toggleAutomation}
          onDelete={requestDeleteAutomation}
        />
        <AutomationListExternalRows
          entries={filteredExternalAutomationEntries}
          selectedExternalKey={selectedExternal?.key}
          relativeNow={relativeNow}
          sshConnectionStates={sshConnectionStates}
          externalActionKey={externalActionKey}
          onSelect={(entryKey) => {
            selectExternalKey(entryKey)
            setActivePaneTab('overview')
          }}
          onRequestAction={requestExternalAction}
          onEdit={openEditExternalDialog}
        />
        {hasListItems && isListSearchActive && !hasFilteredListItems ? (
          <div className="px-3 py-6 text-center text-xs text-muted-foreground">
            {translate(
              'auto.components.automations.AutomationsPage.noSearchMatches',
              'No automations match your search.'
            )}
          </div>
        ) : null}
        {!hasListItems ? (
          <div className="grid gap-2 p-2">
            <div className="px-1 pb-1 text-sm font-medium">
              {translate(
                'auto.components.automations.AutomationsPage.d207ab4c25',
                'Start from a template'
              )}
            </div>
            {getAutomationTemplates().map((template) => (
              <button
                key={template.id}
                type="button"
                onClick={() => openCreateDialog(template)}
                className="rounded-md border border-border/70 bg-background px-3 py-2 text-left shadow-xs transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
              >
                <div className="text-[11px] font-medium uppercase text-muted-foreground">
                  {template.category}
                </div>
                <div className="mt-1 text-sm font-medium">{template.label}</div>
                <div className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                  {template.description}
                </div>
              </button>
            ))}
            <Button
              type="button"
              variant="outline"
              className="mt-1 w-full justify-start"
              onClick={() => openCreateDialog()}
            >
              <Plus className="size-4" />
              {translate('auto.components.automations.AutomationsPage.25060635c6', 'Add new')}
            </Button>
          </div>
        ) : null}
      </div>
    </section>
  )
}
