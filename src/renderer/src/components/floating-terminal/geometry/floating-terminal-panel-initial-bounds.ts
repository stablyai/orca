import {
  getDefaultFloatingTerminalBounds,
  getDefaultFloatingTerminalCommittedBounds,
  getMaximizedFloatingTerminalBounds,
  readPersistedFloatingTerminalPanelBounds,
  resolveFloatingTerminalPanelBounds,
  resolveFloatingTerminalPanelCommittedBounds,
  shouldReconcileFloatingTerminalPanelBounds,
  type FloatingTerminalPanelBounds,
  type FloatingTerminalPanelBoundsSource,
  type FloatingTerminalPanelCommittedBounds
} from './floating-terminal-panel-bounds'
import { shouldRestoreMaximizedPanelBounds } from './floating-terminal-panel-restore-geometry'
import { readPersistedFloatingTerminalPanelViewState } from '../state/floating-terminal-panel-view-state'

export type FloatingTerminalPanelBoundsState = {
  committedBounds: FloatingTerminalPanelCommittedBounds
  renderedBounds: FloatingTerminalPanelBounds
  source: FloatingTerminalPanelBoundsSource
}

export function getDefaultFloatingTerminalPanelBoundsState(): FloatingTerminalPanelBoundsState {
  return {
    committedBounds: getDefaultFloatingTerminalCommittedBounds(),
    renderedBounds: getDefaultFloatingTerminalBounds(),
    source: 'default'
  }
}

export function readInitialPanelBounds(): FloatingTerminalPanelBoundsState {
  const persistedBounds = readPersistedFloatingTerminalPanelBounds()
  if (shouldRestoreMaximizedPanelBounds(readPersistedFloatingTerminalPanelViewState())) {
    // Keep committed bounds as the restore target while maximizing the first paint.
    return {
      committedBounds: persistedBounds ?? getDefaultFloatingTerminalCommittedBounds(),
      renderedBounds: getMaximizedFloatingTerminalBounds(),
      source: persistedBounds ? 'user' : 'default'
    }
  }
  return persistedBounds
    ? {
        committedBounds: persistedBounds,
        renderedBounds: shouldReconcileFloatingTerminalPanelBounds('user')
          ? resolveFloatingTerminalPanelBounds(persistedBounds, 'user')
          : resolveFloatingTerminalPanelCommittedBounds(persistedBounds),
        source: 'user'
      }
    : getDefaultFloatingTerminalPanelBoundsState()
}

export function areFloatingTerminalPanelCommittedBoundsEqual(
  left: FloatingTerminalPanelCommittedBounds | null,
  right: FloatingTerminalPanelCommittedBounds
): boolean {
  return left !== null && JSON.stringify(left) === JSON.stringify(right)
}
