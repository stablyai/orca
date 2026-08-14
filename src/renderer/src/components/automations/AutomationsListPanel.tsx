import React from 'react'
import { Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
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
import type { AutomationPaneTab } from './automation-page-state'
import { getAutomationTemplates, type AutomationTemplate } from './automation-templates'
import { AutomationListLocalRows } from './AutomationListLocalRows'
import { AutomationListExternalRows } from './AutomationListExternalRows'
import { AUTOMATIONS_TABLE_CONTAINER_CLASS } from './automations-table-layout'
import { translate } from '@/i18n/i18n'
import type {
  AutomationListFilter,
  AutomationListSort,
  AutomationListSortField,
  AutomationListViewItem
} from './automation-list-view'
import { AutomationListTableHeader } from './AutomationListTableHeader'
import { AutomationListToolbar } from './AutomationListToolbar'
import { indexLatestAutomationRuns } from './automation-list-last-run'

type AutomationsListPanelProps = {
  hasListItems: boolean
  hasFilteredListItems: boolean
  isListSearchActive: boolean
  isListFilterActive: boolean
  listSearchQuery: string
  isListSearchQueryTooLarge: boolean
  onListSearchQueryChange: (query: string) => void
  visibleItems: readonly AutomationListViewItem[]
  listFilter: AutomationListFilter
  onListFilterChange: (filter: AutomationListFilter) => void
  listSort: AutomationListSort | null
  onListSort: (field: AutomationListSortField) => void
  // Why: use explicit ids, not resolved detail selection (which falls back to the
  // first row) — list highlight should only mark a user-chosen row.
  selectedId: string | null
  selectedExternalKey: string | null
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
  hostLabelById: ReadonlyMap<string, string>
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
  onOpenDetail: () => void
  onRefresh: () => void
  isRefreshing: boolean
}

export function AutomationsListPanel({
  hasListItems,
  hasFilteredListItems,
  isListSearchActive,
  isListFilterActive,
  listSearchQuery,
  isListSearchQueryTooLarge,
  onListSearchQueryChange,
  visibleItems,
  listFilter,
  onListFilterChange,
  listSort,
  onListSort,
  selectedId,
  selectedExternalKey,
  runs,
  relativeNow,
  repoMap,
  worktreeMap,
  projectHostSetups,
  sshConnectionStates,
  runtimeStatusByEnvironmentId,
  automationHostTarget,
  automationSourceHostAvailabilityById,
  hostLabelById,
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
  openCreateDialog,
  onOpenDetail,
  onRefresh,
  isRefreshing
}: AutomationsListPanelProps): React.JSX.Element {
  // Why: one pass over runs for the whole list — each row renders its own
  // component, so indexing per row would be O(rows × runs) on every re-render.
  const lastRunByAutomationId = React.useMemo(() => indexLatestAutomationRuns(runs), [runs])

  return (
    <section
      className="flex min-h-0 flex-1 flex-col overflow-hidden px-3 pb-4 md:px-5"
      data-contextual-tour-target="automations-list"
    >
      {!hasListItems ? (
        <div className="scrollbar-sleek min-h-0 flex-1 overflow-auto">
          <div className="mx-auto grid max-w-2xl gap-2 p-2 pt-6">
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
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-4">
          <AutomationListToolbar
            listSearchQuery={listSearchQuery}
            isListSearchQueryTooLarge={isListSearchQueryTooLarge}
            onListSearchQueryChange={onListSearchQueryChange}
            filter={listFilter}
            onFilterChange={onListFilterChange}
            onRefresh={onRefresh}
            isRefreshing={isRefreshing}
            openCreateDialog={openCreateDialog}
          />

          <div
            className={cn(
              'scrollbar-sleek min-h-0 flex-1 overflow-auto',
              AUTOMATIONS_TABLE_CONTAINER_CLASS
            )}
          >
            {hasFilteredListItems ? (
              <>
                <AutomationListTableHeader sort={listSort} onSort={onListSort} />
                <div className="divide-y divide-border/50">
                  {visibleItems.map((item) =>
                    item.kind === 'local' ? (
                      <AutomationListLocalRows
                        key={item.id}
                        automations={[item.automation]}
                        selectedId={selectedId}
                        isSelectedLocal={selectedExternalKey === null}
                        lastRunByAutomationId={lastRunByAutomationId}
                        relativeNow={relativeNow}
                        repoMap={repoMap}
                        worktreeMap={worktreeMap}
                        projectHostSetups={projectHostSetups}
                        sshConnectionStates={sshConnectionStates}
                        runtimeStatusByEnvironmentId={runtimeStatusByEnvironmentId}
                        automationHostTarget={automationHostTarget}
                        automationSourceHostAvailabilityById={automationSourceHostAvailabilityById}
                        hostLabelById={hostLabelById}
                        onSelect={(automationId) => {
                          selectExternalKey(null)
                          selectAutomationId(automationId)
                          onOpenDetail()
                        }}
                        onRunNow={runNow}
                        onEdit={openEditDialog}
                        onToggle={toggleAutomation}
                        onDelete={requestDeleteAutomation}
                      />
                    ) : (
                      <AutomationListExternalRows
                        key={item.id}
                        entries={[item.entry]}
                        selectedExternalKey={selectedExternalKey}
                        relativeNow={relativeNow}
                        sshConnectionStates={sshConnectionStates}
                        externalActionKey={externalActionKey}
                        onSelect={(entryKey) => {
                          selectAutomationId(null)
                          selectExternalKey(entryKey)
                          setActivePaneTab('overview')
                          onOpenDetail()
                        }}
                        onRequestAction={requestExternalAction}
                        onEdit={openEditExternalDialog}
                      />
                    )
                  )}
                </div>
              </>
            ) : isListSearchActive || isListFilterActive ? (
              <div className="px-3 py-6 text-center text-sm text-muted-foreground">
                {translate(
                  'auto.components.automations.AutomationsPage.noListMatches',
                  'No automations match.'
                )}
              </div>
            ) : null}
          </div>
        </div>
      )}
    </section>
  )
}
