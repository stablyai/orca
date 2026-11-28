import type { TaskPageComposerActionsModel } from '../use-task-page-composer-actions'
import { useTranslate } from '@/i18n/use-translate'
import { useRef } from 'react'
import { RailPagePrimaryButton, RailPageRefreshButton } from '@/components/rail-page/RailPageHeader'
import { RailPageSearch } from '@/components/rail-page/RailPageSearch'
import { RailPageViews } from '@/components/rail-page/RailPageToolbar'
import { TaskPageListBands } from '../ListBands'
import { useAppStore } from '@/store/index'
import { Plus, Search, X } from 'lucide-react'
import LinearIssueAttributeFilterDropdowns from '@/components/task-page/linear/filters/linear-issue-attribute-filter-dropdowns'
import { Input } from '@/components/ui/input'
import { shouldSuppressEnterSubmit } from '@/lib/workspace/creation/new-workspace-enter-guard'
import { defaultScopeSource } from '@/runtime/hosts/selection/default-creation-host'
export function TaskPageLinearFilters({
  model
}: {
  model: TaskPageComposerActionsModel
}): React.JSX.Element | null {
  const t = useTranslate()
  const {
    settings,
    setTaskResumeState,
    linearModeOptions,
    linearTaskSourceContext,
    linearMode,
    linearLoading,
    linearSearchInput,
    setLinearSearchInput,
    setAppliedLinearSearch,
    linearAttributeFilterWorkspaceId,
    linearAttributeFilter,
    setLinearRefreshNonce,
    linearProjectSearchInput,
    setLinearProjectSearchInput,
    setAppliedLinearProjectSearch,
    linearProjectsLoading,
    selectedLinearProject,
    linearProjectDetailLoading,
    linearCustomViewsLoading,
    linearCustomViewContentsLoading,
    selectLinearMode,
    availableTeams,
    linearTeamSelection,
    linearTeamOptions,
    linearAttributePrimaryTeam,
    applyLinearAttributeFilter,
    showLinearAttributeFilters,
    setNewLinearProjectOpen,
    setNewLinearProjectName,
    setNewLinearProjectDescription,
    setNewLinearProjectContent,
    setNewLinearProjectTeamId,
    setNewLinearProjectLeadId,
    setNewLinearProjectMemberIds,
    setNewLinearProjectLabelIds,
    setNewLinearProjectPriority,
    setNewLinearProjectStartDate,
    setNewLinearProjectTargetDate,
    setNewLinearIssueOpen,
    setNewLinearIssueTitle,
    setNewLinearIssueBody,
    setNewLinearIssueTeamId,
    setNewLinearIssueProjectId
  } = model
  const inputRef = useRef<HTMLInputElement>(null)
  const issueMode = linearMode === 'issues' || linearMode === 'in-orca'
  const busy = issueMode
    ? linearLoading
    : linearMode === 'projects'
      ? linearProjectsLoading || linearProjectDetailLoading
      : linearCustomViewsLoading || linearCustomViewContentsLoading
  const views = (
    <RailPageViews
      label={t('auto.components.TaskPage.0cbf7e5cf3', 'Linear task mode')}
      value={linearMode}
      onValueChange={selectLinearMode}
      onReselect={selectLinearMode}
      items={linearModeOptions.map((mode) => ({
        value: mode.id,
        label: mode.label,
        tooltip:
          mode.id === 'in-orca'
            ? t(
                'auto.components.TaskPage.linearModeHasWorktreeTooltip',
                'Linear tickets linked to an Orca workspace'
              )
            : undefined
      }))}
    />
  )
  const actions = (
    <>
      <RailPageRefreshButton
        label={t('auto.components.TaskPage.8964184a8b', 'Refresh Linear')}
        busy={busy}
        onRefresh={() => setLinearRefreshNonce((n) => n + 1)}
      />
      <RailPagePrimaryButton
        icon={<Plus className="size-3.5" />}
        label={t('common.new', 'New')}
        disabled={availableTeams.length === 0}
        aria-label={
          linearMode === 'projects' && !selectedLinearProject
            ? t('auto.components.TaskPage.1361275ec3', 'New Linear project')
            : t('auto.components.TaskPage.3feb524d42', 'New Linear issue')
        }
        onClick={() => {
          if (linearMode === 'projects' && !selectedLinearProject) {
            // Why: restore dismissed typed text (accidental dismissal recoverable); pickers keep their fresh open-time defaults.
            const draft = useAppStore.getState().newLinearProjectDraft
            setNewLinearProjectName(draft?.name ?? '')
            setNewLinearProjectDescription(draft?.description ?? '')
            setNewLinearProjectContent(draft?.content ?? '')
            setNewLinearProjectTeamId(availableTeams[0]?.id ?? null)
            setNewLinearProjectLeadId(null)
            setNewLinearProjectMemberIds([])
            setNewLinearProjectLabelIds([])
            setNewLinearProjectPriority(0)
            setNewLinearProjectStartDate('')
            setNewLinearProjectTargetDate('')
            setNewLinearProjectOpen(true)
            return
          }
          // Why: restore dismissed typed text (accidental dismissal recoverable); pickers keep their fresh open-time defaults.
          const issueDraft = useAppStore.getState().newLinearIssueDraft
          setNewLinearIssueTitle(issueDraft?.title ?? '')
          setNewLinearIssueBody(issueDraft?.body ?? '')
          const projectTeamId =
            selectedLinearProject?.teams?.[0]?.id ??
            availableTeams.find((team) => team.workspaceId === selectedLinearProject?.workspaceId)
              ?.id
          setNewLinearIssueTeamId(projectTeamId ?? availableTeams[0]?.id ?? null)
          setNewLinearIssueProjectId(selectedLinearProject?.id ?? null)
          setNewLinearIssueOpen(true)
        }}
      />
    </>
  )
  const search = issueMode ? (
    <RailPageSearch inputRef={inputRef} hasValue={Boolean(linearSearchInput)}>
      <div className="relative w-full min-w-0">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          ref={inputRef}
          value={linearSearchInput}
          onChange={(e) => setLinearSearchInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              if (
                shouldSuppressEnterSubmit(
                  {
                    isComposing: e.nativeEvent.isComposing,
                    shiftKey: e.shiftKey
                  },
                  false
                )
              ) {
                return
              }
              e.preventDefault()
              const trimmed = linearSearchInput.trim()
              setLinearSearchInput(trimmed)
              setAppliedLinearSearch(trimmed)
              setTaskResumeState({
                linearQuery: trimmed,
                linearMode: linearMode === 'in-orca' ? 'in-orca' : 'issues'
              })
              if (linearMode !== 'in-orca') {
                setLinearRefreshNonce((n) => n + 1)
              }
            }
          }}
          placeholder={
            linearMode === 'in-orca'
              ? t(
                  'auto.components.TaskPage.linearHasWorktreeSearchPlaceholder',
                  'Filter issues linked to an Orca workspace...'
                )
              : t('auto.components.TaskPage.eec0c5c079', 'Search...')
          }
          aria-label={
            linearMode === 'in-orca'
              ? undefined
              : t(
                  'auto.components.new.workspace.SmartWorkspaceNameField.searchLinear',
                  'Search Linear issues'
                )
          }
          density="compact"
          surface="background"
          inset="leadingIcon"
          adornment={linearSearchInput ? 'trailing' : 'shortcut'}
        />
        {linearSearchInput ? (
          <button
            type="button"
            aria-label={t('auto.components.TaskPage.b797bdd7c3', 'Clear search')}
            onClick={() => {
              inputRef.current?.focus({ preventScroll: true })
              setLinearSearchInput('')
              setAppliedLinearSearch('')
              setTaskResumeState({
                linearQuery: '',
                linearMode: linearMode === 'in-orca' ? 'in-orca' : 'issues'
              })
              if (linearMode !== 'in-orca') {
                setLinearRefreshNonce((n) => n + 1)
              }
            }}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground transition hover:text-foreground"
          >
            <X className="size-4" />
          </button>
        ) : null}
      </div>
    </RailPageSearch>
  ) : linearMode === 'projects' && !selectedLinearProject ? (
    <RailPageSearch inputRef={inputRef} hasValue={Boolean(linearProjectSearchInput)}>
      <div className="relative w-full min-w-0">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          ref={inputRef}
          value={linearProjectSearchInput}
          onChange={(e) => setLinearProjectSearchInput(e.target.value)}
          placeholder={t('auto.components.TaskPage.0b65d3fb2c', 'Search Linear projects...')}
          density="compact"
          surface="background"
          inset="leadingIcon"
          adornment={linearProjectSearchInput ? 'trailing' : 'shortcut'}
        />
        {linearProjectSearchInput ? (
          <button
            type="button"
            aria-label={t('auto.components.TaskPage.b797bdd7c3', 'Clear search')}
            onClick={() => {
              inputRef.current?.focus({ preventScroll: true })
              setLinearProjectSearchInput('')
              setAppliedLinearProjectSearch('')
              setLinearRefreshNonce((n) => n + 1)
            }}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground transition hover:text-foreground"
          >
            <X className="size-4" />
          </button>
        ) : null}
      </div>
    </RailPageSearch>
  ) : null
  return (
    <LinearIssueAttributeFilterDropdowns
      enabled={issueMode && showLinearAttributeFilters}
      value={linearAttributeFilter}
      onChange={applyLinearAttributeFilter}
      workspaceId={linearAttributeFilterWorkspaceId}
      primaryTeam={linearAttributePrimaryTeam}
      selectedTeamIds={[...linearTeamSelection]}
      availableTeams={linearTeamOptions}
      teamsSettled={availableTeams.length > 0}
      settings={linearTaskSourceContext ?? defaultScopeSource(settings)}
      render={(filter, pills) => (
        <TaskPageListBands
          model={model}
          views={views}
          actions={actions}
          controls={
            <>
              {filter}
              {search}
            </>
          }
          notices={pills}
        />
      )}
    />
  )
}
