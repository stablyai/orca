import {
  isRemoteRuntimePtyId,
  parseRemoteRuntimePtyId,
  toRemoteRuntimePtyId
} from '../../../../shared/remote-runtime/remote-runtime-pty-id'
import { isTerminalTabPresent } from '../slices/terminal-tab-retirement'
import type { TerminalSlice, TerminalStoreGet, TerminalStoreSet } from './terminal-state'
import {
  consumePendingActivationSpawn,
  getPendingActivationSpawnCount
} from './terminal-pty-identities'
import { omitUnverifiedPtyLossTabIds } from './terminal-unverified-pty-loss'
import { clearWorktreeSleepIntent } from '@/lib/worktree-sleep-intent'
import { omitDisownedPtyIds } from './terminal-disowned-pty-sources'

export function createTerminalPtyBindingActions(
  set: TerminalStoreSet,
  get: TerminalStoreGet
): Pick<TerminalSlice, 'updateTabPtyId'> {
  return {
    updateTabPtyId: (tabId, ptyId, replacedPtyId) => {
      // Why: final guard preventing a late caller from recreating retired tab maps (async spawn owners still do their own provider teardown).
      if (!isTerminalTabPresent(get(), tabId)) {
        return
      }
      let worktreeId: string | null = null
      let wasActivationSpawn = false
      const isRemoteRuntimeMirror = isRemoteRuntimePtyId(ptyId)
      set((s) => {
        const existingPtyIds = s.ptyIdsByTabId[tabId] ?? []
        const remote = parseRemoteRuntimePtyId(ptyId)
        const legacyRemotePtyId = remote?.environmentId ? toRemoteRuntimePtyId(remote.handle) : null
        const hasLegacyPtyBinding = legacyRemotePtyId
          ? existingPtyIds.includes(legacyRemotePtyId)
          : false
        const explicitReplacementPtyId = replacedPtyId !== ptyId ? replacedPtyId : undefined
        const replacementPtyId =
          explicitReplacementPtyId ?? (hasLegacyPtyBinding ? legacyRemotePtyId : null)
        const boundReplacementPtyId =
          replacementPtyId && existingPtyIds.includes(replacementPtyId) ? replacementPtyId : null
        const nextPtyIds = boundReplacementPtyId
          ? [...new Set(existingPtyIds.map((id) => (id === boundReplacementPtyId ? ptyId : id)))]
          : existingPtyIds.includes(ptyId)
            ? existingPtyIds
            : [...existingPtyIds, ptyId]
        // Keep provider handle rotation atomic across tab and pane ownership.
        let nextTerminalLayoutsByTabId = s.terminalLayoutsByTabId
        if (replacementPtyId) {
          const existingLayout = s.terminalLayoutsByTabId[tabId]
          const existingBindings = existingLayout?.ptyIdsByLeafId
          if (existingLayout && existingBindings) {
            let changed = false
            const nextBindings = Object.fromEntries(
              Object.entries(existingBindings).map(([leafId, currentPtyId]) => {
                if (currentPtyId !== replacementPtyId) {
                  return [leafId, currentPtyId]
                }
                changed = true
                return [leafId, ptyId]
              })
            )
            if (changed) {
              nextTerminalLayoutsByTabId = {
                ...s.terminalLayoutsByTabId,
                [tabId]: { ...existingLayout, ptyIdsByLeafId: nextBindings }
              }
            }
          }
        }
        let nextTabsByWorktree = s.tabsByWorktree
        for (const [wId, tabs] of Object.entries(s.tabsByWorktree)) {
          const index = tabs.findIndex((t) => t.id === tabId)
          if (index === -1) {
            continue
          }
          worktreeId = wId
          const tab = tabs[index]
          if (getPendingActivationSpawnCount(tab.pendingActivationSpawn) > 0) {
            wasActivationSpawn = true
          }
          // Why: consume one suppression per split-pane activation callback.
          const { pendingActivationSpawn: _unused, restoredFromSession: _restored, ...rest } = tab
          void _unused
          void _restored
          // Keep legacy single-pane tab.ptyId fallback stable; later split spawns must not redirect remount/close to another PTY.
          const currentTabPtyId = tab.ptyId === replacementPtyId ? ptyId : tab.ptyId
          const nextTabPtyId = currentTabPtyId ?? nextPtyIds[0] ?? null
          const nextPendingActivationSpawn = consumePendingActivationSpawn(
            tab.pendingActivationSpawn
          )
          if (tab.pendingActivationSpawn || tab.ptyId !== nextTabPtyId) {
            const nextTabs = [...tabs]
            nextTabs[index] = {
              ...rest,
              ...(nextPendingActivationSpawn
                ? { pendingActivationSpawn: nextPendingActivationSpawn }
                : {}),
              ptyId: nextTabPtyId
            }
            nextTabsByWorktree = { ...s.tabsByWorktree, [wId]: nextTabs }
          }
          break
        }
        // Why: the first active PTY changes sorting, except activation-spawn side effects.
        const isFirstPty = existingPtyIds.length === 0
        const isActiveWorktree = worktreeId != null && s.activeWorktreeId === worktreeId
        const shouldBumpSortEpoch = isFirstPty && isActiveWorktree && !wasActivationSpawn
        const shouldRetainSuppressedExit = Boolean(
          explicitReplacementPtyId &&
          (s.suppressedPtyExitIds[ptyId] ||
            (replacementPtyId && s.suppressedPtyExitIds[replacementPtyId]))
        )
        const nextSuppressedPtyExitIds = { ...s.suppressedPtyExitIds }
        delete nextSuppressedPtyExitIds[ptyId]
        if (replacementPtyId) {
          delete nextSuppressedPtyExitIds[replacementPtyId]
        }
        if (shouldRetainSuppressedExit) {
          // Why: handle rotation keeps the same terminal lifecycle; an intentional exit racing the rotation must stay suppressed once.
          nextSuppressedPtyExitIds[ptyId] = true
        }
        const nextUnverifiedPtyLossTabIds = s.unverifiedPtyLossTabIds[tabId]
          ? omitUnverifiedPtyLossTabIds(s.unverifiedPtyLossTabIds, [tabId])
          : s.unverifiedPtyLossTabIds
        // Redeployed relays reuse IDs; rebinding must retire stale disownership for the old incarnation.
        const nextDisownedPtyIds = omitDisownedPtyIds(
          s.disownedPtyIds,
          replacementPtyId ? [ptyId, replacementPtyId] : [ptyId]
        )
        const hasReplacementPendingRestart = replacementPtyId
          ? replacementPtyId in s.pendingPaneAccountRestarts
          : false
        const hasReplacementRestartNotice = replacementPtyId
          ? replacementPtyId in s.codexRestartNoticeByPtyId
          : false
        const hasReplacementMigrationUnsupported = replacementPtyId
          ? replacementPtyId in s.migrationUnsupportedByPtyId
          : false
        const nextPendingPaneAccountRestarts = hasReplacementPendingRestart
          ? { ...s.pendingPaneAccountRestarts }
          : s.pendingPaneAccountRestarts
        const nextCodexRestartNoticeByPtyId = hasReplacementRestartNotice
          ? { ...s.codexRestartNoticeByPtyId }
          : s.codexRestartNoticeByPtyId
        const nextMigrationUnsupportedByPtyId = hasReplacementMigrationUnsupported
          ? { ...s.migrationUnsupportedByPtyId }
          : s.migrationUnsupportedByPtyId
        if (replacementPtyId) {
          if (hasReplacementPendingRestart) {
            nextPendingPaneAccountRestarts[ptyId] = nextPendingPaneAccountRestarts[replacementPtyId]
            delete nextPendingPaneAccountRestarts[replacementPtyId]
          }
          if (hasReplacementRestartNotice) {
            const replacedNotice = nextCodexRestartNoticeByPtyId[replacementPtyId]
            nextCodexRestartNoticeByPtyId[ptyId] ??= replacedNotice
            delete nextCodexRestartNoticeByPtyId[replacementPtyId]
          }
          if (hasReplacementMigrationUnsupported) {
            const replacedMigrationUnsupported = nextMigrationUnsupportedByPtyId[replacementPtyId]
            nextMigrationUnsupportedByPtyId[ptyId] ??= {
              ...replacedMigrationUnsupported,
              ptyId
            }
            delete nextMigrationUnsupportedByPtyId[replacementPtyId]
          }
        }
        return {
          ...(nextTabsByWorktree !== s.tabsByWorktree
            ? { tabsByWorktree: nextTabsByWorktree }
            : {}),
          ptyIdsByTabId: {
            ...s.ptyIdsByTabId,
            [tabId]: nextPtyIds
          },
          lastKnownRelayPtyIdByTabId: {
            ...s.lastKnownRelayPtyIdByTabId,
            [tabId]: ptyId
          },
          ...(nextUnverifiedPtyLossTabIds !== s.unverifiedPtyLossTabIds
            ? { unverifiedPtyLossTabIds: nextUnverifiedPtyLossTabIds }
            : {}),
          ...(nextDisownedPtyIds !== s.disownedPtyIds
            ? { disownedPtyIds: nextDisownedPtyIds }
            : {}),
          suppressedPtyExitIds: nextSuppressedPtyExitIds,
          pendingPaneAccountRestarts: nextPendingPaneAccountRestarts,
          codexRestartNoticeByPtyId: nextCodexRestartNoticeByPtyId,
          migrationUnsupportedByPtyId: nextMigrationUnsupportedByPtyId,
          ...(nextTerminalLayoutsByTabId !== s.terminalLayoutsByTabId
            ? { terminalLayoutsByTabId: nextTerminalLayoutsByTabId }
            : {}),
          ...(shouldBumpSortEpoch ? { sortEpoch: s.sortEpoch + 1 } : {})
        }
      })
      // Why: a bound PTY means the workspace is awake by any route (CLI, automation, client wake), not only activation.
      clearWorktreeSleepIntent(worktreeId)
      // Why: activation spawns come from clicking a worktree, not work in it — skip the lastActivityAt stamp and sortEpoch bump; other spawn reasons still bump.
      if (worktreeId && !wasActivationSpawn && !isRemoteRuntimeMirror) {
        get().bumpWorktreeActivity(worktreeId)
      }
    }
  }
}
