import type { TaskPageClickUpStateModel } from './clickup/use-task-page-clickup-state'
import { useEffect } from 'react'
import { addAppKeyListener, removeAppKeyListener } from '@/lib/keyboard/app-keyboard-router'
import { hasVisibleOverlay } from '@/lib/overlay-interaction/visible-overlay'

function isTextEntryTarget(target: HTMLElement): boolean {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    target.isContentEditable
  )
}

export function useTaskPageGlobalEffects(model: TaskPageClickUpStateModel) {
  const {
    closeTaskPage,
    closeTaskDetailPage,
    taskSource,
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
    githubListPending,
    tasksRefreshing,
    tasksFiltering,
    dialogWorkItem,
    newIssueOpen,
    selectedLinearIssue,
    selectedJiraIssue,
    selectedClickUpTask,
    newLinearIssueOpen,
    newJiraIssueOpen
  } = model
  const githubTasksBusy = githubListPending || tasksRefreshing || tasksFiltering
  // GitHub and Linear details replace the list in-page; the Jira and ClickUp details are Sheets that own Esc.
  const detailPageOpen =
    (taskSource === 'github' && Boolean(dialogWorkItem)) ||
    (taskSource === 'linear' && Boolean(selectedLinearIssue))
  useEffect(() => {
    // Why: when a modal is open, let it own Esc dismissal.
    if (
      selectedJiraIssue ||
      selectedClickUpTask ||
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
    selectedJiraIssue,
    selectedClickUpTask
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

  const nextModel = model as typeof model & {
    githubTasksBusy: typeof githubTasksBusy
  }
  nextModel.githubTasksBusy = githubTasksBusy
  return nextModel
}
export type TaskPageGlobalEffectsModel = ReturnType<typeof useTaskPageGlobalEffects>
