import { useCallback, useEffect, useRef, useState } from 'react'
import { useAppStore } from '@/store'
import { claimCombinedDiffFileTreeHint } from './combined-diff-file-tree-hint-claim'

// Why: let the diff finish loading and the toolbar settle (SSH hosts are slower)
// before anchoring a popover to the file-tree button.
const COMBINED_DIFF_FILE_TREE_HINT_DELAY_MS = 600

export type CombinedDiffFileTreeHintInput = {
  eligible: boolean
  /** Whether this surface is on screen; a mounted-but-hidden pane must never hold the callout. */
  surfaceActive: boolean
}

export type CombinedDiffFileTreeHint = { hintOpen: boolean; dismissHint: () => void }

// One-shot discovery callout for the combined-diff file tree. The persisted flag is
// written on first show, not on dismiss, so closing the tab without answering still
// counts as shown.
export function useCombinedDiffFileTreeHint({
  eligible,
  surfaceActive
}: CombinedDiffFileTreeHintInput): CombinedDiffFileTreeHint {
  const dismissCombinedDiffFileTreeHint = useAppStore((s) => s.dismissCombinedDiffFileTreeHint)
  const [hintOpen, setHintOpen] = useState(false)
  // Why: showing writes the store flag, which immediately drops `eligible`; without
  // this the same effect would close the popover it just opened.
  const shownRef = useRef(false)

  useEffect(() => {
    if (shownRef.current || !eligible) {
      return
    }
    const timer = window.setTimeout(() => {
      // Why claim inside the timer: two split panes share this deadline, so the winner is
      // only decided when a callback actually runs.
      if (!claimCombinedDiffFileTreeHint()) {
        return
      }
      shownRef.current = true
      dismissCombinedDiffFileTreeHint()
      setHintOpen(true)
    }, COMBINED_DIFF_FILE_TREE_HINT_DELAY_MS)
    return () => window.clearTimeout(timer)
  }, [dismissCombinedDiffFileTreeHint, eligible])

  if (hintOpen && !surfaceActive) {
    // Why close during render, not in an effect: the workbench is CSS-hidden rather than
    // unmounted, so a callout left open would reappear on every return to the workspace.
    setHintOpen(false)
  }

  const dismissHint = useCallback(() => setHintOpen(false), [])
  return { hintOpen: hintOpen && surfaceActive, dismissHint }
}
