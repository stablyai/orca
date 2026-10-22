import { scheduleNextFrame } from '@/components/terminal-pane/terminal-ime-input-context-refresh'
import { focusPanePreservingOverlays } from './pane-overlay-focus'
import type { ManagedPane } from './pane-manager-types'

const CLAIM_FRAMES = 2

type SplitPaneFocusClaimArgs = {
  pane: Pick<ManagedPane, 'id' | 'container' | 'terminal'>
  getActivePaneId: () => number | null
  isPaneLive: () => boolean
  requestFrame?: (callback: () => void) => void
}

// Why: the synchronous focus after a split can be undone in the next frames (IME
// blur/refocus, resize-frame cancellation); re-assert it without fighting any other owner.
export function claimSplitPaneFocus(args: SplitPaneFocusClaimArgs): void {
  const requestFrame = args.requestFrame ?? scheduleNextFrame
  const claim = (framesLeft: number): void => {
    requestFrame(() => {
      if (
        typeof document === 'undefined' ||
        !args.isPaneLive() ||
        args.getActivePaneId() !== args.pane.id
      ) {
        return
      }
      if (shouldReclaimFocus(document.activeElement, args.pane.container)) {
        focusPanePreservingOverlays(args.pane)
      }
      if (framesLeft > 1) {
        claim(framesLeft - 1)
      }
    })
  }
  claim(CLAIM_FRAMES)
}

function shouldReclaimFocus(active: Element | null, paneContainer: HTMLElement): boolean {
  if (active === null || active === document.body) {
    return true
  }
  if (paneContainer.contains(active)) {
    return false
  }
  return active.matches('.xterm-helper-textarea')
}
