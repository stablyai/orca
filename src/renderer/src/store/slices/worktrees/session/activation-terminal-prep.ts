import type { WorktreeSliceSet } from '../listing/worktree-slice-types'
import type { TerminalTab } from '../../../../../../shared/terminal-tab-types'
import type { WorktreeSelectionOwner } from '@/lib/worktree-selection-owner'
import { isCurrentWorktreeSelection } from '@/lib/worktree-selection-owner'
import { tabHasLivePty } from '@/lib/tab-has-live-pty'
import { scheduleAfterInputQuiet } from '@/lib/input-quiet-scheduler'
import { getTerminalActivationSpawnSuppression } from '../../terminal-activation-spawn-suppression'
import {
  ACTIVE_WORKTREE_TERMINAL_PREP_DELAY_MS,
  ACTIVE_WORKTREE_TERMINAL_PREP_IDLE_TIMEOUT_MS,
  ACTIVE_WORKTREE_TERMINAL_PREP_INPUT_QUIET_MS
} from '../listing/worktree-slice-constants'

export const pendingActivationTerminalPrepCancels = new Map<string, () => void>()

export function shouldDeferActivationTerminalPrep(): boolean {
  return typeof window !== 'undefined' && import.meta.env.MODE !== 'test'
}

export function prepareActivationTerminalTabs(
  set: WorktreeSliceSet,
  worktreeId: string,
  selectedOwner: WorktreeSelectionOwner | undefined,
  isWakeable: (tab: TerminalTab) => boolean,
  shouldTagTerminalTabs: boolean
): void {
  const prepareTerminalTabs = (): void => {
    pendingActivationTerminalPrepCancels.delete(worktreeId)
    set((s) => {
      if (!isCurrentWorktreeSelection(s, worktreeId, selectedOwner)) {
        return s
      }
      const tabs = s.tabsByWorktree[worktreeId] ?? []
      const wakeable = tabs.filter(isWakeable)
      if (wakeable.length === 0) {
        return s
      }
      const allDead = wakeable.every((tab) => !tabHasLivePty(s.ptyIdsByTabId, tab.id))
      if (!allDead && !shouldTagTerminalTabs) {
        return s
      }
      return {
        tabsByWorktree: {
          ...s.tabsByWorktree,
          [worktreeId]: tabs.map((tab) =>
            !isWakeable(tab)
              ? tab
              : {
                  ...tab,
                  ...(allDead ? { generation: (tab.generation ?? 0) + 1 } : {}),
                  // Why: slept terminal remount/spawn is click-driven wake work; tag its PTY updates so they don't reshuffle Recent.
                  pendingActivationSpawn: getTerminalActivationSpawnSuppression(
                    s.terminalLayoutsByTabId[tab.id]
                  )
                }
          )
        }
      }
    })
  }

  const cancelExistingPrep = pendingActivationTerminalPrepCancels.get(worktreeId)
  if (cancelExistingPrep) {
    cancelExistingPrep()
  }
  if (shouldDeferActivationTerminalPrep()) {
    pendingActivationTerminalPrepCancels.set(
      worktreeId,
      scheduleAfterInputQuiet(prepareTerminalTabs, {
        delayMs: ACTIVE_WORKTREE_TERMINAL_PREP_DELAY_MS,
        quietMs: ACTIVE_WORKTREE_TERMINAL_PREP_INPUT_QUIET_MS,
        idleTimeoutMs: ACTIVE_WORKTREE_TERMINAL_PREP_IDLE_TIMEOUT_MS
      })
    )
  } else {
    prepareTerminalTabs()
  }
}
