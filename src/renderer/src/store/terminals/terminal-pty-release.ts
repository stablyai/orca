import { replaceTabBuckets, replaceRecordEntries } from '@/store/keyed-record-transitions'
import { getFirstTerminalTabOwnerWorktreeId } from './terminal-tab-owner-index'
import { isRemoteRuntimePtyId } from '../../../../shared/remote-runtime/remote-runtime-pty-id'
import { hasWorktreeSleepIntent } from '@/lib/worktree-sleep-intent'
import type { TerminalSlice, TerminalStoreGet, TerminalStoreSet } from './terminal-state'
import {
  consumePendingActivationSpawn,
  getPendingActivationSpawnCount
} from './terminal-pty-identities'

export function createTerminalPtyReleaseActions(
  set: TerminalStoreSet,
  get: TerminalStoreGet
): Pick<TerminalSlice, 'clearTabPtyId'> {
  return {
    clearTabPtyId: (tabId, ptyId) => {
      if (ptyId && get().pendingPtyShutdownIds[ptyId]) {
        // Why: an owner exit can arrive before its post-stop inventory; keep the renderer binding retryable until verification commits.
        return
      }
      let worktreeId: string | null = null
      let wasActivationSpawn = false
      let isRemoteRuntimeMirror = isRemoteRuntimePtyId(ptyId)
      set((s) => {
        const existingPtyIds = s.ptyIdsByTabId[tabId] ?? []
        const remainingPtyIds = ptyId ? existingPtyIds.filter((id) => id !== ptyId) : []
        let nextTabsByWorktree = s.tabsByWorktree
        const ownerId = getFirstTerminalTabOwnerWorktreeId(s.tabsByWorktree, tabId)
        for (const wId of ownerId ? [ownerId] : []) {
          const tabs = s.tabsByWorktree[wId] ?? []
          const index = tabs.findIndex((t) => t.id === tabId)
          if (index === -1) {
            continue
          }
          worktreeId = wId
          const tab = tabs[index]
          if (getPendingActivationSpawnCount(tab.pendingActivationSpawn) > 0) {
            wasActivationSpawn = true
          }
          if (!ptyId) {
            isRemoteRuntimeMirror =
              existingPtyIds.length > 0 && existingPtyIds.every((id) => isRemoteRuntimePtyId(id))
          }
          // Why: consume pendingActivationSpawn on real activation clears, but keep it when clearing a stale wake-hint id — its fallback spawn still needs the suppression.
          const { pendingActivationSpawn: _unused, ...rest } = tab
          void _unused
          const nextTabPtyId = remainingPtyIds.at(-1) ?? null
          const shouldRetainActivationSpawn =
            wasActivationSpawn && ptyId != null && !existingPtyIds.includes(ptyId)
          const nextPendingActivationSpawn = shouldRetainActivationSpawn
            ? tab.pendingActivationSpawn
            : consumePendingActivationSpawn(tab.pendingActivationSpawn)
          if (tab.pendingActivationSpawn || tab.ptyId !== nextTabPtyId) {
            const nextTabs = [...tabs]
            nextTabs[index] = {
              ...rest,
              ...(nextPendingActivationSpawn
                ? { pendingActivationSpawn: nextPendingActivationSpawn }
                : {}),
              ptyId: nextTabPtyId
            }
            nextTabsByWorktree = replaceTabBuckets(s.tabsByWorktree, [[wId, nextTabs]])
          }
          break
        }
        // Repo purge can retire the tab before exit; a missing owner must not regain bindings.
        const nextPtyIdsByTabId = replaceRecordEntries(s.ptyIdsByTabId, [
          [tabId, worktreeId ? remainingPtyIds : null]
        ])
        const nextPendingPaneAccountRestarts = { ...s.pendingPaneAccountRestarts }
        const nextCodexRestartNoticeByPtyId = { ...s.codexRestartNoticeByPtyId }
        if (ptyId) {
          delete nextPendingPaneAccountRestarts[ptyId]
          delete nextCodexRestartNoticeByPtyId[ptyId]
        } else {
          for (const currentPtyId of s.ptyIdsByTabId[tabId] ?? []) {
            delete nextPendingPaneAccountRestarts[currentPtyId]
            delete nextCodexRestartNoticeByPtyId[currentPtyId]
          }
        }
        // Why: an explicit exit drops the dead relay ID; bulk clears retain it for relay grace.
        const relayReplacements: [string, string | null][] = []
        if (ptyId && s.lastKnownRelayPtyIdByTabId[tabId] === ptyId) {
          // If last-bound relay slot exits, promote a survivor or later bulk relay clearing makes orphan sweep delete the still-live split tab (#9911).
          relayReplacements.push([tabId, remainingPtyIds.at(-1) || null])
        }
        return {
          ...(nextTabsByWorktree !== s.tabsByWorktree
            ? {
                tabsByWorktree: nextTabsByWorktree
              }
            : {}),
          ptyIdsByTabId: nextPtyIdsByTabId,
          lastKnownRelayPtyIdByTabId: replaceRecordEntries(
            s.lastKnownRelayPtyIdByTabId,
            relayReplacements
          ),
          pendingPaneAccountRestarts: nextPendingPaneAccountRestarts,
          codexRestartNoticeByPtyId: nextCodexRestartNoticeByPtyId
        }
      })
      // Bump activity on PTY exit, but skip intentional shutdowns (suppressed exits) and click-driven pane unmounts (pendingActivationSpawn).
      if (
        worktreeId &&
        !wasActivationSpawn &&
        !isRemoteRuntimeMirror &&
        !hasWorktreeSleepIntent(worktreeId) &&
        !(ptyId && get().suppressedPtyExitIds[ptyId])
      ) {
        get().bumpWorktreeActivity(worktreeId)
      }
    }
  }
}
