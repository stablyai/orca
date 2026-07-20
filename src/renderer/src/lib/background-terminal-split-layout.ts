import type { TerminalLayoutSnapshot } from '../../../shared/types'

type BackgroundPane = {
  leafId: string
  ptyId: string
}

export function buildBackgroundTerminalSplitLayout(
  first: BackgroundPane,
  second: BackgroundPane,
  direction: 'horizontal' | 'vertical',
  secondTitle: string
): TerminalLayoutSnapshot {
  return {
    root: {
      type: 'split',
      direction,
      first: { type: 'leaf', leafId: first.leafId },
      second: { type: 'leaf', leafId: second.leafId }
    },
    activeLeafId: first.leafId,
    expandedLeafId: null,
    ptyIdsByLeafId: {
      [first.leafId]: first.ptyId,
      [second.leafId]: second.ptyId
    },
    titlesByLeafId: { [second.leafId]: secondTitle }
  }
}
