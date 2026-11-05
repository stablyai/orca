import { useEffect, useState } from 'react'

type ComposerPaneHandoffInput = {
  composerOpen: boolean
  paneActive: boolean
  workspaceViewActive: boolean
  closeComposer: () => void
}

/** Whether the dialog host stays empty because the view left the workspace while the pane hosted the composer. */
export function useComposerPaneHandoff({
  composerOpen,
  paneActive,
  workspaceViewActive,
  closeComposer
}: ComposerPaneHandoffInput): boolean {
  // Why: the pane unmounts in the commit that changes the view, so the latch must be visible this render.
  const [paneHosted, setPaneHosted] = useState(paneActive)
  if (paneActive && !paneHosted) {
    setPaneHosted(true)
  }
  // Why: a creation surface taking the center hands the composer to the dialog on purpose; keep that dialog.
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
