/**
 * Restarts an SSH host's terminal tabs when "Move to managed server" stopped their relay shells but
 * the host stayed on the relay. Main marks exactly the shells it stops as a restart, so every
 * viewer keeps those tabs through the exit; this only brings the stopped ones back.
 */
import type { SshManagedServerMoveResult } from '../../../shared/ssh-managed-server-move'
import { parseAppSshPtyId } from '../../../shared/ssh-pty-id'
import { discardPreHandlerPtyState } from '@/components/terminal-pane/pty-pre-handler-buffer'
import type { AppState } from '@/store/types'
import { useAppStore } from '@/store'

type RelayTerminalBinding = { tabId: string; ptyId: string }

type TerminalBindingState = Pick<
  AppState,
  'tabsByWorktree' | 'ptyIdsByTabId' | 'terminalLayoutsByTabId'
>

export function collectSshTargetTerminalBindings(
  state: TerminalBindingState,
  targetId: string
): RelayTerminalBinding[] {
  const bindings = new Map<string, RelayTerminalBinding>()
  for (const tabs of Object.values(state.tabsByWorktree)) {
    for (const tab of tabs) {
      const ptyIds = [
        tab.ptyId,
        ...(state.ptyIdsByTabId[tab.id] ?? []),
        ...Object.values(state.terminalLayoutsByTabId[tab.id]?.ptyIdsByLeafId ?? {})
      ]
      for (const ptyId of ptyIds) {
        if (ptyId && parseAppSshPtyId(ptyId)?.connectionId === targetId) {
          bindings.set(ptyId, { tabId: tab.id, ptyId })
        }
      }
    }
  }
  return [...bindings.values()]
}

export async function moveRestartingStoppedTabs(
  targetId: string,
  move: () => Promise<SshManagedServerMoveResult>
): Promise<SshManagedServerMoveResult> {
  // Why before the move: the stop clears each tab's live binding, but the tab still owns its shell.
  const bindings = collectSshTargetTerminalBindings(useAppStore.getState(), targetId)
  const result = await move()
  if (result.outcome !== 'moved') {
    restartStoppedTabs(bindings, new Set(result.stoppedPtyIds))
  }
  return result
}

function restartStoppedTabs(
  bindings: readonly RelayTerminalBinding[],
  stoppedPtyIds: ReadonlySet<string>
): void {
  const restartTabIds = new Set<string>()
  for (const { tabId, ptyId } of bindings) {
    if (stoppedPtyIds.has(ptyId)) {
      // A buffered exit would end the remounted pane before it spawns its replacement.
      discardPreHandlerPtyState(ptyId)
      restartTabIds.add(tabId)
    }
  }
  const store = useAppStore.getState()
  for (const tabId of restartTabIds) {
    store.remountTerminalTabForRecovery(tabId)
  }
}
