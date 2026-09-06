import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import { isValidHostTerminalTabId } from '../../../../shared/terminal-tab-id'
import { emptyLayoutSnapshot, singlePaneLayoutSnapshot } from '../slices/terminal-helpers'
import { isTerminalLeafId } from '../../../../shared/stable-pane-id'
import {
  buildOrphanTerminalCleanupPatch,
  getOrphanTerminalIds
} from '../slices/terminal-orphan-helpers'
import {
  dedupeTabOrder,
  ensureGroup,
  findTabByEntityInGroup,
  pushRecentTabId,
  sanitizeRecentTabIds,
  updateGroup
} from '../slices/tab-group-state'
import { createBrowserUuid } from '@/lib/browser-uuid'
import { getLocalProjectExecutionRuntimeContext } from '@/lib/local-preflight-context'
import type { TerminalSlice, TerminalStoreGet, TerminalStoreSet } from './terminal-state'
import {
  getRemoteConnectionIdForWorktree,
  resolveCreatedTabShellOverride,
  worktreeUsesWslPath
} from './terminal-workspace-routing'
export function getNextTerminalOrdinal(tabs: TerminalTab[]): number {
  const usedOrdinals = new Set<number>()
  for (const tab of tabs) {
    const match = /^Terminal (\d+)$/.exec(tab.defaultTitle ?? tab.title)
    if (!match) {
      continue
    }
    usedOrdinals.add(Number(match[1]))
  }
  let nextOrdinal = 1
  while (usedOrdinals.has(nextOrdinal)) {
    nextOrdinal += 1
  }
  return nextOrdinal
}

type TabStartupCommand = TerminalSlice['pendingStartupByTabId'][string]

function normalizeTabStartupCommand(startup: TabStartupCommand): TabStartupCommand {
  // Why: launchToken is only meaningful for tracked launch-config reuse; plain startup commands must not mint a synthetic token.
  const launchToken = startup.launchConfig
    ? (startup.launchToken ?? createBrowserUuid())
    : undefined
  return {
    ...startup,
    ...(launchToken ? { launchToken } : {})
  }
}

export function createTerminalTabCreationActions(
  set: TerminalStoreSet,
  get: TerminalStoreGet
): Pick<TerminalSlice, 'createTab'> {
  return {
    createTab: (worktreeId, targetGroupId, shellOverride, options) => {
      let tab!: TerminalTab
      set((s) => {
        const orphanTerminalIds = getOrphanTerminalIds(s, worktreeId)
        const orphanCleanupPatch = buildOrphanTerminalCleanupPatch(s, worktreeId, orphanTerminalIds)
        const existing = (s.tabsByWorktree[worktreeId] ?? []).filter(
          (entry) => !orphanTerminalIds.has(entry.id)
        )
        // Why: honor a caller-supplied tab id but mint on collision — aliasing two PTYs to one id corrupts agent-status routing. See docs/cli-terminal-hook-pane-key.md.
        // Why: only honor a non-empty trimmed hint; useIpcEvents spreads `id` whenever tabId !== undefined, so a stray '' would break paneKey routing.
        const trimmedHint = typeof options?.id === 'string' ? options.id.trim() : ''
        const hintedId =
          trimmedHint.length > 0 && isValidHostTerminalTabId(trimmedHint) ? trimmedHint : undefined
        const idCollides =
          hintedId !== undefined &&
          Object.values(s.tabsByWorktree).some((tabs) =>
            tabs.some((entry) => entry.id === hintedId)
          )
        if (idCollides) {
          console.warn(
            `[createTab] tabId hint ${hintedId} already exists; minting a fresh id (hook attribution will degrade for this terminal)`
          )
        }
        const id = hintedId !== undefined && !idCollides ? hintedId : createBrowserUuid()
        const requestedInitialLeafId =
          options?.initialLeafId && isTerminalLeafId(options.initialLeafId)
            ? options.initialLeafId
            : undefined
        // Why: startup delivery is pane-owned; pin its first leaf so an aborted/remounted renderer retries against the same spawn reservation.
        const initialLeafId =
          options?.initialPtyId || options?.pendingStartup
            ? (requestedInitialLeafId ?? createBrowserUuid())
            : undefined
        const shouldActivate = options?.activate !== false
        const nextOrdinal = getNextTerminalOrdinal(existing)
        const defaultTitle = `Terminal ${nextOrdinal}`
        const quickCommandLabel = options?.quickCommandLabel?.trim()
        const startupCwd = options?.startupCwd
        const remoteConnectionId = getRemoteConnectionIdForWorktree(s, worktreeId)
        const isRemoteWorktree = Boolean(remoteConnectionId)
        const isWslWorktree = worktreeUsesWslPath(s, worktreeId)
        const createdShellOverride = resolveCreatedTabShellOverride(
          shellOverride,
          s.settings?.terminalWindowsShell,
          // Why: SSH PTYs ignore local Windows shell selection; a local shell icon would mislabel a remote terminal.
          isRemoteWorktree,
          remoteConnectionId
            ? ((s.sshConnectionStates.get(remoteConnectionId)
                ?.remotePlatform as NodeJS.Platform | null) ?? null)
            : null,
          // Why: new terminals enter the worktree's repo-scoped WSL distro even when the global Windows shell is PowerShell/cmd.exe.
          isWslWorktree,
          isRemoteWorktree || options?.forceHostRuntime
            ? undefined
            : getLocalProjectExecutionRuntimeContext(s, worktreeId)
        )
        tab = {
          id,
          // Why: CLI-created background sessions already own a PTY, so reveal attaches instead of spawning a duplicate.
          ptyId: options?.initialPtyId ?? null,
          worktreeId,
          // Why: reuse the lowest free ordinal so a fresh terminal stays "Terminal 1" after older tabs close, not a monotonic counter.
          title: defaultTitle,
          defaultTitle,
          ...(quickCommandLabel ? { quickCommandLabel } : {}),
          customTitle: null,
          color: null,
          sortOrder: existing.length,
          createdAt: Date.now(),
          ...(createdShellOverride !== undefined ? { shellOverride: createdShellOverride } : {}),
          ...(startupCwd && startupCwd.length > 0 ? { startupCwd } : {}),
          ...(options?.forceHostRuntime ? { forceHostRuntime: true } : {}),
          ...(options?.launchAgent ? { launchAgent: options.launchAgent } : {}),
          // Why: mark click-caused (not work-caused) spawns so updateTabPtyId skips the activity/sortEpoch bump that would reorder Recent/Smart on click.
          ...(options?.pendingActivationSpawn ? { pendingActivationSpawn: true } : {})
        }
        const validTargetGroupId =
          targetGroupId &&
          s.groupsByWorktree[worktreeId]?.some((group) => group.id === targetGroupId)
            ? targetGroupId
            : undefined
        const { group, groupsByWorktree, activeGroupIdByWorktree } = ensureGroup(
          s.groupsByWorktree,
          s.activeGroupIdByWorktree,
          worktreeId,
          validTargetGroupId ?? s.activeGroupIdByWorktree[worktreeId]
        )
        const nextActiveGroupIdByWorktree =
          shouldActivate && validTargetGroupId
            ? { ...activeGroupIdByWorktree, [worktreeId]: validTargetGroupId }
            : activeGroupIdByWorktree
        const existingUnifiedTabs = s.unifiedTabsByWorktree[worktreeId] ?? []
        const existingTerminalTab = findTabByEntityInGroup(
          s.unifiedTabsByWorktree,
          worktreeId,
          group.id,
          id,
          'terminal'
        )
        const groupsForWorktree = groupsByWorktree[worktreeId] ?? []
        const cleanedGroups =
          orphanTerminalIds.size === 0
            ? groupsForWorktree
            : groupsForWorktree.map((entry) => {
                // Why: repair every group before adding the new tab, or inactive/background creation can revive stale focus.
                const tabOrder = dedupeTabOrder(entry.tabOrder).filter(
                  (tabId) => !orphanTerminalIds.has(tabId)
                )
                const recentTabIds = sanitizeRecentTabIds(entry.recentTabIds, tabOrder)
                const replacedActiveTabId = Boolean(
                  entry.activeTabId && orphanTerminalIds.has(entry.activeTabId)
                )
                const fallbackActiveTabId = recentTabIds.at(-1) ?? tabOrder[0] ?? null
                const activeTabId = replacedActiveTabId ? fallbackActiveTabId : entry.activeTabId
                return {
                  ...entry,
                  activeTabId,
                  tabOrder,
                  recentTabIds:
                    replacedActiveTabId && activeTabId
                      ? pushRecentTabId(recentTabIds, activeTabId)
                      : recentTabIds
                }
              })
        const cleanedTargetGroup = cleanedGroups.find((entry) => entry.id === group.id) ?? group
        const cleanedGroupOrder = dedupeTabOrder(cleanedTargetGroup.tabOrder).filter(
          (tabId) => !orphanTerminalIds.has(tabId)
        )
        const unifiedTab = existingTerminalTab ?? {
          id,
          entityId: id,
          groupId: group.id,
          worktreeId,
          contentType: 'terminal' as const,
          label: tab.title,
          ...(tab.quickCommandLabel?.trim()
            ? { quickCommandLabel: tab.quickCommandLabel.trim() }
            : {}),
          customLabel: tab.customTitle,
          color: tab.color,
          sortOrder: cleanedGroupOrder.length,
          createdAt: tab.createdAt,
          // Why: omit for non-agent tabs so they keep the implicit 'terminal' view mode.
          ...(options?.viewMode ? { viewMode: options.viewMode } : {})
        }
        const nextGroupOrder = dedupeTabOrder([...cleanedGroupOrder, unifiedTab.id])
        const nextRecent = shouldActivate
          ? pushRecentTabId(sanitizeRecentTabIds(group.recentTabIds, nextGroupOrder), unifiedTab.id)
          : sanitizeRecentTabIds(cleanedTargetGroup.recentTabIds, nextGroupOrder)
        const cleanedActiveTabIdForWorktree = orphanCleanupPatch.activeTabIdByWorktree[worktreeId]
        const cleanedGroupActiveTabId =
          cleanedTargetGroup.activeTabId && !orphanTerminalIds.has(cleanedTargetGroup.activeTabId)
            ? cleanedTargetGroup.activeTabId
            : null
        const nextActiveTabIdForWorktree = shouldActivate
          ? tab.id
          : (cleanedActiveTabIdForWorktree ?? cleanedGroupActiveTabId ?? tab.id)
        return {
          ...orphanCleanupPatch,
          tabsByWorktree: {
            ...orphanCleanupPatch.tabsByWorktree,
            [worktreeId]: [...existing, tab]
          },
          // Why: publish the unified tab atomically with the runtime tab so a transient legacy mount can't race the split host.
          unifiedTabsByWorktree: {
            ...s.unifiedTabsByWorktree,
            [worktreeId]: existingTerminalTab
              ? existingUnifiedTabs
              : [...existingUnifiedTabs, unifiedTab]
          },
          groupsByWorktree: {
            ...groupsByWorktree,
            [worktreeId]: updateGroup(cleanedGroups, {
              ...cleanedTargetGroup,
              activeTabId: shouldActivate
                ? unifiedTab.id
                : (cleanedGroupActiveTabId ?? unifiedTab.id),
              tabOrder: nextGroupOrder,
              recentTabIds: nextRecent
            })
          },
          activeGroupIdByWorktree: nextActiveGroupIdByWorktree,
          layoutByWorktree: {
            ...s.layoutByWorktree,
            [worktreeId]: s.layoutByWorktree[worktreeId] ?? { type: 'leaf', groupId: group.id }
          },
          activeTabId: shouldActivate ? tab.id : orphanCleanupPatch.activeTabId,
          activeTabIdByWorktree: {
            ...orphanCleanupPatch.activeTabIdByWorktree,
            [worktreeId]: nextActiveTabIdForWorktree
          },
          ptyIdsByTabId: {
            ...orphanCleanupPatch.ptyIdsByTabId,
            [tab.id]: options?.initialPtyId ? [options.initialPtyId] : []
          },
          pendingStartupByTabId: options?.pendingStartup
            ? {
                ...orphanCleanupPatch.pendingStartupByTabId,
                [tab.id]: normalizeTabStartupCommand(options.pendingStartup)
              }
            : orphanCleanupPatch.pendingStartupByTabId,
          automaticAgentResumeClaimsByTabId: options?.automaticResumeClaim
            ? {
                ...orphanCleanupPatch.automaticAgentResumeClaimsByTabId,
                [tab.id]: options.automaticResumeClaim
              }
            : orphanCleanupPatch.automaticAgentResumeClaimsByTabId,
          terminalLayoutsByTabId: {
            ...orphanCleanupPatch.terminalLayoutsByTabId,
            [tab.id]: initialLeafId
              ? singlePaneLayoutSnapshot(initialLeafId, options?.initialPtyId)
              : emptyLayoutSnapshot()
          }
        }
      })
      const shouldRecordInteraction =
        options?.recordInteraction ?? (!options?.pendingActivationSpawn && !options?.initialPtyId)
      if (shouldRecordInteraction) {
        get().recordFeatureInteraction?.('terminal-tabs')
      }
      return tab
    }
  }
}
