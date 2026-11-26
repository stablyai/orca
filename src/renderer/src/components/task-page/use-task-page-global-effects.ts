import type { TaskPageJiraSummaryGenerationModel } from './jira/creation/use-task-page-jira-summary-generation'
import { useEffect, useRef } from 'react'
import { addAppKeyListener, removeAppKeyListener } from '@/lib/keyboard/app-keyboard-router'
import { hasVisibleOverlay } from '@/lib/overlay-interaction/visible-overlay'
import { selectProviderPreflightRefreshTargets } from './task-page-preflight-recheck'

function isTextEntryTarget(target: HTMLElement): boolean {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    target.isContentEditable
  )
}

export function useTaskPageGlobalEffects(model: TaskPageJiraSummaryGenerationModel) {
  const {
    closeTaskPage,
    closeTaskDetailPage,
    taskSource,
    activeModal,
    linearStatusContextKey,
    preflightStatus,
    preflightStatusChecked,
    preflightStatusContextKey,
    preflightStatusError,
    preflightDescribesDesktop,
    runtimePreflightStatusByHostId,
    refreshRuntimePreflightHosts,
    checkLinearConnection,
    refreshPreflightStatus,
    expectedPreflightContextKey,
    selectedReposKey,
    taskSourceRepoContexts,
    jiraStatusContextKey,
    checkJiraConnection,
    providerRuntimeContextKey,
    preflightStatusCurrent,
    linearStatusReady,
    jiraStatusReady,
    githubListPending,
    tasksRefreshing,
    tasksFiltering,
    dialogWorkItem,
    newIssueOpen,
    selectedLinearIssue,
    selectedJiraIssue,
    newLinearIssueOpen,
    newJiraIssueOpen
  } = model
  const githubTasksBusy = githubListPending || tasksRefreshing || tasksFiltering
  const forcedPreflightKeyRef = useRef<string | null>(null)
  // GitHub and Linear details replace the list in-page; the Jira detail is a Sheet that owns Esc.
  const detailPageOpen =
    (taskSource === 'github' && Boolean(dialogWorkItem)) ||
    (taskSource === 'linear' && Boolean(selectedLinearIssue))
  useEffect(() => {
    // Why: when a modal is open, let it own Esc dismissal.
    if (
      selectedJiraIssue ||
      newIssueOpen ||
      newLinearIssueOpen ||
      newJiraIssueOpen ||
      activeModal !== 'none'
    ) {
      return
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') {
        return
      }
      const target = event.target
      if (!(target instanceof HTMLElement)) {
        return
      }

      if (detailPageOpen) {
        // Why: fields (reply, description, mentions) and overlays on the detail own Esc; the
        // router runs first in capture, so blurring here would also trigger their cancel.
        if (event.defaultPrevented || isTextEntryTarget(target) || hasVisibleOverlay()) {
          return
        }
        event.preventDefault()
        closeTaskDetailPage()
        return
      }

      // Why: open menus/popovers/selects own Esc; capture-phase leave would steal it from Radix.
      if (hasVisibleOverlay()) {
        return
      }

      // Esc first blurs input; leave the page only when focus is outside one.
      if (isTextEntryTarget(target)) {
        event.preventDefault()
        target.blur()
        return
      }
      event.preventDefault()
      closeTaskPage()
    }
    addAppKeyListener('keydown', onKeyDown)
    return () => removeAppKeyListener('keydown', onKeyDown)
  }, [
    activeModal,
    closeTaskDetailPage,
    closeTaskPage,
    detailPageOpen,
    newIssueOpen,
    newLinearIssueOpen,
    newJiraIssueOpen,
    selectedJiraIssue
  ])
  useEffect(() => {
    if (!preflightStatusCurrent || !preflightStatusChecked) {
      void refreshPreflightStatus()
    }
    const targets = selectProviderPreflightRefreshTargets({
      taskSource,
      contexts: taskSourceRepoContexts,
      preflightStatus,
      preflightStatusChecked,
      preflightStatusCurrent,
      preflightDescribesDesktop,
      runtimePreflightStatusByHostId
    })
    const refreshKey =
      targets.desktop || targets.runtimeHostIds.length > 0
        ? [
            expectedPreflightContextKey,
            selectedReposKey,
            taskSource,
            targets.desktop ? 'desktop' : '',
            targets.runtimeHostIds.join(',')
          ].join('|')
        : null
    if (preflightStatusError) {
      // Retry on a later open/focus; forcing again in this effect would loop.
      forcedPreflightKeyRef.current = null
    } else if (!refreshKey) {
      forcedPreflightKeyRef.current = null
    } else if (forcedPreflightKeyRef.current !== refreshKey) {
      forcedPreflightKeyRef.current = refreshKey
      if (targets.desktop) {
        void refreshPreflightStatus({ force: true })
      }
      if (targets.runtimeHostIds.length > 0) {
        void refreshRuntimePreflightHosts(targets.runtimeHostIds)
      }
    }
    if (!linearStatusReady) {
      void checkLinearConnection()
    }
    if (!jiraStatusReady) {
      void checkJiraConnection()
    }
  }, [
    checkJiraConnection,
    checkLinearConnection,
    expectedPreflightContextKey,
    jiraStatusContextKey,
    jiraStatusReady,
    linearStatusContextKey,
    linearStatusReady,
    preflightDescribesDesktop,
    preflightStatus,
    providerRuntimeContextKey,
    preflightStatusContextKey,
    preflightStatusChecked,
    preflightStatusCurrent,
    preflightStatusError,
    refreshPreflightStatus,
    refreshRuntimePreflightHosts,
    runtimePreflightStatusByHostId,
    selectedReposKey,
    taskSource,
    taskSourceRepoContexts
  ])

  const nextModel = model as typeof model & {
    githubTasksBusy: typeof githubTasksBusy
  }
  nextModel.githubTasksBusy = githubTasksBusy
  return nextModel
}
export type TaskPageGlobalEffectsModel = ReturnType<typeof useTaskPageGlobalEffects>
