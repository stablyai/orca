import type { TuiAgent } from '../../../shared/tui-agent'

export type WorktreeActivationSurfaceSelection = {
  /** The create picker's selection; null means Blank Terminal. */
  agent?: TuiAgent | null
  /** A navigation caller is about to open its own editor, diff, or other non-terminal surface. */
  providesInitialSurface?: boolean
}

export function activationProvidesInitialSurface(
  selection?: WorktreeActivationSurfaceSelection
): boolean {
  return selection?.providesInitialSurface === true || selection?.agent != null
}
