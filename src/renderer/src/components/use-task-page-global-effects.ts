import type { TaskPageJiraIssueCreationModel } from './use-task-page-jira-issue-creation'
import { useEffect } from 'react'
import { useAppStore } from '@/store'
import { useDismissTaskPageOverlaysWhenHidden } from './use-dismiss-task-page-overlays'
export function useTaskPageGlobalEffects(model: TaskPageJiraIssueCreationModel) {
  const {
    closeTaskPage,
    activeModal,
    linearStatusContextKey,
    preflightStatusChecked,
    preflightStatusContextKey,
    checkLinearConnection,
    refreshPreflightStatus,
    expectedPreflightContextKey,
    jiraStatusContextKey,
    checkJiraConnection,
    providerRuntimeContextKey,
    preflightStatusCurrent,
    linearStatusReady,
    jiraStatusReady,
    tasksLoading,
    tasksRefreshing,
    tasksFiltering,
    dialogWorkItem,
    newIssueOpen,
    selectedLinearIssue,
    selectedJiraIssue,
    newLinearIssueOpen,
    newJiraIssueOpen,
    setNewIssueOpen,
    setNewLinearIssueOpen,
    setNewLinearProjectOpen,
    setNewJiraIssueOpen,
    setNewJiraIssueProjectComboboxOpen,
    setLinearConnectOpen,
    setJiraConnectOpen
  } = model
  useDismissTaskPageOverlaysWhenHidden({
    setNewIssueOpen,
    setNewLinearIssueOpen,
    setNewLinearProjectOpen,
    setNewJiraIssueOpen,
    setNewJiraIssueProjectComboboxOpen,
    setLinearConnectOpen,
    setJiraConnectOpen
  })
  const githubTasksBusy = tasksLoading || tasksRefreshing || tasksFiltering
  useEffect(() => {
    // Why: when a modal is open, let it own Esc dismissal.
    if (
      dialogWorkItem ||
      selectedJiraIssue ||
      selectedLinearIssue ||
      newIssueOpen ||
      newLinearIssueOpen ||
      newJiraIssueOpen ||
      activeModal !== 'none'
    ) {
      return
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      // Why: keep-mounted Tasks still owned window Esc and would wipe the parked issue off-view.
      if (event.key !== 'Escape' || useAppStore.getState().activeView !== 'tasks') {
        return
      }
      const target = event.target
      if (!(target instanceof HTMLElement)) {
        return
      }

      // Why: open menus/popovers/selects own Esc; capture-phase leave would steal it from Radix.
      if (
        document.querySelector(
          '[data-slot="dropdown-menu-content"], [data-slot="popover-content"], [data-slot="select-content"], [role="menu"]'
        )
      ) {
        return
      }

      // Why: Esc first blurs a focused input so it doesn't accidentally close the whole page; only closes once focus is outside an input.
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        target.isContentEditable
      ) {
        event.preventDefault()
        target.blur()
        return
      }
      event.preventDefault()
      closeTaskPage()
    }
    window.addEventListener('keydown', onKeyDown, {
      capture: true
    })
    return () =>
      window.removeEventListener('keydown', onKeyDown, {
        capture: true
      })
  }, [
    activeModal,
    closeTaskPage,
    dialogWorkItem,
    newIssueOpen,
    newLinearIssueOpen,
    newJiraIssueOpen,
    selectedLinearIssue,
    selectedJiraIssue
  ])
  useEffect(() => {
    if (!preflightStatusCurrent || !preflightStatusChecked) {
      void refreshPreflightStatus()
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
    providerRuntimeContextKey,
    preflightStatusContextKey,
    preflightStatusChecked,
    preflightStatusCurrent,
    refreshPreflightStatus
  ])

  // Why: debounce the Linear search input so we don't fire a request per keystroke (300ms, matching GitHub search).
  const nextModel = model as typeof model & {
    githubTasksBusy: typeof githubTasksBusy
  }
  nextModel.githubTasksBusy = githubTasksBusy
  return nextModel
}
export type TaskPageGlobalEffectsModel = ReturnType<typeof useTaskPageGlobalEffects>
