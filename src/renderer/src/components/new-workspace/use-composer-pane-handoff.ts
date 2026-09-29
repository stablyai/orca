import { useEffect, useState } from 'react'

type ComposerPaneHandoffInput = {
  composerOpen: boolean
  paneActive: boolean
  workspaceViewActive: boolean
  closeComposer: () => void
}

/**
 * Whether the dialog host must stay empty because the view left the workspace while the center
 * pane hosted an open composer. Why: the pane unmounts in the same commit that changes the view,
 * so it can't observe the change itself; without this the dialog would remount with an empty prompt.
 */
export function useComposerPaneHandoff({
  composerOpen,
  paneActive,
  workspaceViewActive,
  closeComposer
}: ComposerPaneHandoffInput): boolean {
  // Why a latch in state: it has to be visible in this render, so the dialog never mounts.
  const [paneHosted, setPaneHosted] = useState(paneActive)
  if (paneActive && !paneHosted) {
    setPaneHosted(true)
  }
  // Why: a creation surface taking the center (e.g. "Create more") hands the composer to the
  // dialog on purpose, so a later view change must not dismiss that dialog.
  if (paneHosted && (!composerOpen || (!paneActive && workspaceViewActive))) {
    setPaneHosted(false)
  }
  const handingOff = composerOpen && paneHosted && !workspaceViewActive
  useEffect(() => {
    if (handingOff) {
      closeComposer()
    }
  }, [handingOff, closeComposer])
  return handingOff
}
