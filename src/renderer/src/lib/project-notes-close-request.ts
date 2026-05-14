export const ORCA_PROJECT_NOTES_REQUEST_CLOSE_EVENT = 'orca:project-notes-request-close'

export type ProjectNotesCloseRequestDetail = {
  tabId: string
  close: () => void
  claim: () => void
}

export function requestProjectNotesTabClose(tabId: string, close: () => void): void {
  let claimed = false
  window.dispatchEvent(
    new CustomEvent<ProjectNotesCloseRequestDetail>(ORCA_PROJECT_NOTES_REQUEST_CLOSE_EVENT, {
      detail: {
        tabId,
        close,
        claim: () => {
          claimed = true
        }
      }
    })
  )
  // Why: Project Notes tabs are normally mounted so dirty state can prompt on
  // close, but close requests should still complete if a tab shell exists
  // before its lazy content has attached a listener.
  if (!claimed) {
    close()
  }
}
