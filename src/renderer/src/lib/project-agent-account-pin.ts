import type { AppState } from '@/store'
import { getRepoIdFromWorktreeId } from '../../../shared/worktree/id'
import { getCodexSelectionLaneKey } from '../../../shared/codex-selection-lane'
import { parseWslUncPath } from '../../../shared/wsl-paths'

export type ProjectPinAgent = 'claude' | 'codex'

/** A project's saved account and the lane it runs in (`host` or `wsl:<distro>`). Launches honor a
 *  pin only in that lane; a session in any other lane follows that lane's selection. */
export type ProjectAccountPin = { accountId: string; laneKey: string }

/** The saved account (host or WSL) a project pins an agent's sessions to, whatever is selected;
 *  null when none or when that account is gone. */
export function projectAccountPin(
  state: Pick<AppState, 'repos' | 'settings'>,
  agent: ProjectPinAgent,
  worktreeId: string | null | undefined
): ProjectAccountPin | null {
  if (!worktreeId) {
    return null
  }
  const repoId = getRepoIdFromWorktreeId(worktreeId)
  const repo = state.repos.find((candidate) => candidate.id === repoId)
  const accountId = agent === 'claude' ? repo?.claudeAccountId : repo?.codexAccountId
  if (!accountId) {
    return null
  }
  if (agent === 'claude') {
    const saved = state.settings?.claudeManagedAccounts.find((account) => account.id === accountId)
    if (!saved) {
      return null
    }
    const wsl = saved.managedAuthRuntime === 'wsl'
    return { accountId, laneKey: laneKey(wsl, saved.wslDistro) }
  }
  const saved = state.settings?.codexManagedAccounts.find((account) => account.id === accountId)
  if (!saved) {
    return null
  }
  // Older WSL accounts only record their home as a UNC path.
  const legacyDistro = parseWslUncPath(saved.managedHomePath)?.distro
  const wsl = saved.managedHomeRuntime === 'wsl' || legacyDistro !== undefined
  return { accountId, laneKey: laneKey(wsl, saved.wslDistro ?? legacyDistro) }
}

function laneKey(wsl: boolean, wslDistro: string | null | undefined): string {
  return getCodexSelectionLaneKey(wsl ? { runtime: 'wsl', wslDistro } : { runtime: 'host' })
}

/** Whether a pin's lane is `laneKey`. Distro names compare without case, as launches do. */
export function isPinLane(pin: ProjectAccountPin | null, laneKey: string): boolean {
  return pin !== null && pin.laneKey.toLowerCase() === laneKey.toLowerCase()
}
