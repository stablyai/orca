import { parseAppSshPtyId } from '../../../../shared/ssh-pty-id'
import { parseRemoteRuntimePtyId, toRemoteRuntimePtyId } from '@/runtime/runtime-terminal-stream'
import { isTerminalTabPresent } from '../slices/terminal-tab-retirement'
import type { TerminalSlice, TerminalStoreGet, TerminalStoreSet } from './terminal-state'
import {
  consumePendingActivationSpawn,
  getPendingActivationSpawnCount,
  isCurrentDirectSshAuthority,
  isRemoteRuntimePtyId
} from './terminal-pty-identities'

export function createTerminalPtyBindingActions(
  set: TerminalStoreSet,
  get: TerminalStoreGet
): Pick<TerminalSlice, 'updateTabPtyId'> {
  return {
    updateTabPtyId: (tabId, ptyId, replacedPtyId, directSshRetryAttemptId) => {
      // Why: final guard preventing a late caller from recreating retired tab maps (async spawn owners still do their own provider teardown).
      if (!isTerminalTabPresent(get(), tabId)) {
        return
      }
      let worktreeId: string | null = null
      let wasActivationSpawn = false
      const isRemoteRuntimeMirror = isRemoteRuntimePtyId(ptyId)
      set((s) => {
        if (directSshRetryAttemptId) {
          const pendingRetry = s.directSshPaneRetryByTabId[tabId]
          const liveRetry = s.directSshLivePtyBindingByTabId[tabId]
          const retryLease =
            pendingRetry?.attemptId === directSshRetryAttemptId
              ? pendingRetry
              : liveRetry?.attemptId === directSshRetryAttemptId
                ? liveRetry
                : undefined
          const boundTab = Object.values(s.tabsByWorktree)
            .flat()
            .find((candidate) => candidate.id === tabId)
          if (
            !retryLease ||
            !boundTab ||
            parseAppSshPtyId(ptyId)?.connectionId !== retryLease.authority.targetId ||
            !isCurrentDirectSshAuthority(s, retryLease.authority) ||
            (boundTab.generation ?? 0) !== retryLease.tabGeneration
          ) {
            return s
          }
        }
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
          const { pendingActivationSpawn: _unused, ...rest } = tab
          void _unused
          // Why: tab.ptyId is the single-pane fallback for legacy attach; later split-pane spawns must not steal it or remount/close reattaches the tab to the wrong PTY.
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
        const hasReplacementPendingRestart = replacementPtyId
          ? replacementPtyId in s.pendingCodexPaneRestartIds
          : false
        const hasReplacementRestartNotice = replacementPtyId
          ? replacementPtyId in s.codexRestartNoticeByPtyId
          : false
        const hasReplacementMigrationUnsupported = replacementPtyId
          ? replacementPtyId in s.migrationUnsupportedByPtyId
          : false
        const nextPendingCodexPaneRestartIds = hasReplacementPendingRestart
          ? { ...s.pendingCodexPaneRestartIds }
          : s.pendingCodexPaneRestartIds
        const nextCodexRestartNoticeByPtyId = hasReplacementRestartNotice
          ? { ...s.codexRestartNoticeByPtyId }
          : s.codexRestartNoticeByPtyId
        const nextMigrationUnsupportedByPtyId = hasReplacementMigrationUnsupported
          ? { ...s.migrationUnsupportedByPtyId }
          : s.migrationUnsupportedByPtyId
        if (replacementPtyId) {
          if (hasReplacementPendingRestart) {
            nextPendingCodexPaneRestartIds[ptyId] = true
            delete nextPendingCodexPaneRestartIds[replacementPtyId]
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
        const pendingRetry = s.directSshPaneRetryByTabId[tabId]
        const liveRetry = s.directSshLivePtyBindingByTabId[tabId]
        const retryLease =
          pendingRetry?.attemptId === directSshRetryAttemptId
            ? pendingRetry
            : liveRetry?.attemptId === directSshRetryAttemptId
              ? liveRetry
              : undefined
        const boundTab = worktreeId
          ? nextTabsByWorktree[worktreeId]?.find((candidate) => candidate.id === tabId)
          : undefined
        const parsedSshPty = parseAppSshPtyId(ptyId)
        const acknowledgesDirectSshRetry = Boolean(
          retryLease &&
          boundTab &&
          parsedSshPty?.connectionId === retryLease.authority.targetId &&
          isCurrentDirectSshAuthority(s, retryLease.authority) &&
          (boundTab.generation ?? 0) === retryLease.tabGeneration &&
          nextPtyIds.includes(ptyId)
        )
        let nextDirectSshPaneRetryByTabId = s.directSshPaneRetryByTabId
        let nextDirectSshLivePtyBindingByTabId = s.directSshLivePtyBindingByTabId
        if (acknowledgesDirectSshRetry && retryLease && boundTab?.ptyId) {
          if (pendingRetry?.attemptId === directSshRetryAttemptId) {
            nextDirectSshPaneRetryByTabId = { ...s.directSshPaneRetryByTabId }
            delete nextDirectSshPaneRetryByTabId[tabId]
          }
          if (!liveRetry || liveRetry.attemptId !== directSshRetryAttemptId) {
            nextDirectSshLivePtyBindingByTabId = {
              ...s.directSshLivePtyBindingByTabId,
              [tabId]: {
                attemptId: retryLease.attemptId,
                authority: retryLease.authority,
                tabGeneration: retryLease.tabGeneration,
                ptyId: boundTab.ptyId
              }
            }
          } else if (
            (replacementPtyId === liveRetry.ptyId && boundTab.ptyId === ptyId) ||
            !nextPtyIds.includes(liveRetry.ptyId)
          ) {
            nextDirectSshLivePtyBindingByTabId = {
              ...s.directSshLivePtyBindingByTabId,
              [tabId]: { ...liveRetry, ptyId: boundTab.ptyId }
            }
          }
        } else {
          const liveBinding = s.directSshLivePtyBindingByTabId[tabId]
          if (liveBinding) {
            if (
              replacementPtyId === liveBinding.ptyId &&
              boundTab?.ptyId === ptyId &&
              isCurrentDirectSshAuthority(s, liveBinding.authority)
            ) {
              nextDirectSshLivePtyBindingByTabId = {
                ...s.directSshLivePtyBindingByTabId,
                [tabId]: { ...liveBinding, ptyId }
              }
            }
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
          suppressedPtyExitIds: nextSuppressedPtyExitIds,
          pendingCodexPaneRestartIds: nextPendingCodexPaneRestartIds,
          codexRestartNoticeByPtyId: nextCodexRestartNoticeByPtyId,
          migrationUnsupportedByPtyId: nextMigrationUnsupportedByPtyId,
          directSshPaneRetryByTabId: nextDirectSshPaneRetryByTabId,
          directSshLivePtyBindingByTabId: nextDirectSshLivePtyBindingByTabId,
          ...(shouldBumpSortEpoch ? { sortEpoch: s.sortEpoch + 1 } : {})
        }
      })
      // Why: activation spawns come from clicking a worktree, not work in it — skip the lastActivityAt stamp and sortEpoch bump; other spawn reasons still bump.
      if (worktreeId && !wasActivationSpawn && !isRemoteRuntimeMirror) {
        get().bumpWorktreeActivity(worktreeId)
      }
    }
  }
}
