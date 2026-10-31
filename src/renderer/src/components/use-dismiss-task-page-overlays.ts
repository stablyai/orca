import { useContext, useEffect, useLayoutEffect, useRef } from 'react'
import { OverlayAllowedContext } from '@/lib/overlay-allowed-context'

export type TaskPageOverlayFlagSetters = {
  setNewIssueOpen: (open: boolean) => void
  setNewLinearIssueOpen: (open: boolean) => void
  setNewLinearProjectOpen: (open: boolean) => void
  setNewJiraIssueOpen: (open: boolean) => void
  setNewJiraIssueProjectComboboxOpen: (open: boolean) => void
  setLinearConnectOpen: (open: boolean) => void
  setJiraConnectOpen: (open: boolean) => void
}

export function dismissTaskPageOverlayFlags(setters: TaskPageOverlayFlagSetters): void {
  setters.setNewIssueOpen(false)
  setters.setNewLinearIssueOpen(false)
  setters.setNewLinearProjectOpen(false)
  setters.setNewJiraIssueOpen(false)
  setters.setNewJiraIssueProjectComboboxOpen(false)
  setters.setLinearConnectOpen(false)
  setters.setJiraConnectOpen(false)
}

export function useDismissTaskPageOverlaysWhenHidden(setters: TaskPageOverlayFlagSetters): void {
  const overlaysAllowed = useContext(OverlayAllowedContext)
  const settersRef = useRef(setters)
  useLayoutEffect(() => {
    settersRef.current = setters
  })
  useEffect(() => {
    if (overlaysAllowed) {
      return
    }
    dismissTaskPageOverlayFlags(settersRef.current)
  }, [overlaysAllowed])
}
