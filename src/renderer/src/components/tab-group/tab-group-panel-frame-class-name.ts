import { cn } from '@/lib/utils'

/** TabGroupPanel's root className: pane borders, composed via cn() so no computed
 *  fragment is ever spliced into another template literal. */
export function tabGroupPanelFrameClassName(args: {
  hasSplitGroups: boolean
  touchesLeftEdge: boolean
  touchesRightEdge: boolean
  touchesBottomEdge: boolean
  suppressLeftBorder: boolean
  suppressRightBorder: boolean
  suppressBottomBorder: boolean
  isFocused: boolean
}): string {
  const {
    hasSplitGroups,
    touchesLeftEdge,
    touchesRightEdge,
    touchesBottomEdge,
    suppressLeftBorder,
    suppressRightBorder,
    suppressBottomBorder,
    isFocused
  } = args
  return cn(
    // Keep vertical seams neutral and change only the bottom focus border.
    `group/tab-group relative flex flex-col flex-1 min-w-0 min-h-0 overflow-hidden${
      hasSplitGroups
        ? // Why: skip border-l/border-r on edge-touching groups; the split-layout wrapper and right sidebar already paint borders at those seams (double line otherwise).
          ` ${
            touchesLeftEdge || suppressLeftBorder ? '' : 'border-l'
          } ${touchesRightEdge || suppressRightBorder ? '' : 'border-r'} ${
            touchesBottomEdge || suppressBottomBorder ? '' : 'border-b'
          } border-border ${
            isFocused && !touchesBottomEdge && !suppressBottomBorder ? 'border-b-accent' : ''
          }`
        : ''
    }`
  )
}
