import { useAppStore } from '@/store'
import type { ExecutionHostId } from '../../../shared/execution-host'
import { revealUnifiedTabPaletteTarget } from './unified-tab-palette-reveal'

export type SimulatorTabPaletteActivationFailure = 'missing-tab' | 'missing-worktree'

export type SimulatorTabPaletteActivationResult =
  | { status: 'activated'; tabId: string }
  | { status: 'blocked' }
  | { status: 'failed'; reason: SimulatorTabPaletteActivationFailure }

export type SimulatorTabPaletteActivationTarget = {
  executionHostId?: ExecutionHostId
  tabId: string
  worktreeId: string
}

export function activateSimulatorTabPaletteResult(
  target: SimulatorTabPaletteActivationTarget
): SimulatorTabPaletteActivationResult {
  const revealed = revealUnifiedTabPaletteTarget(target, 'simulator')
  if (revealed.status !== 'revealed') {
    return revealed
  }
  const { tab } = revealed
  const state = useAppStore.getState()
  state.focusGroup(target.worktreeId, tab.groupId)
  state.activateTab(tab.id, { worktreeId: target.worktreeId })
  state.setActiveTab(tab.id)
  state.setActiveTabType('simulator', target.worktreeId)
  return { status: 'activated', tabId: tab.id }
}
