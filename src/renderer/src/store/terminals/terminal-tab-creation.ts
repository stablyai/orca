import { resolveTerminalCreatedShell } from './terminal-created-shell'
import { warnIfZCodeCannotOpenSession } from '@/components/terminal-pane/zcode-missing-tui-notice'
import { clearWorktreeSleepIntent } from '@/lib/worktree-sleep-intent'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import {
  isValidHostTerminalTabId,
  isValidMirroredHostTerminalTabId
} from '../../../../shared/terminal-tab-id'
import { getNextTerminalOrdinal } from '../../../../shared/workspace-layout/terminal-tab-ordinal'
import { singlePaneLayoutSnapshot } from '../slices/terminal-helpers'
import { isTerminalLeafId } from '../../../../shared/stable-pane-id'
import {
  buildOrphanTerminalCleanupPatch,
  getOrphanTerminalIds
} from '../slices/terminal-orphan-helpers'
import {
  ensureGroup,
  findTabByEntityInGroup,
  pushRecentTabId,
  sanitizeRecentTabIds,
  updateGroup
} from '../slices/tab-group-state'
import { dedupeTabOrder } from '../../../../shared/workspace-layout/tab-order'
import { createBrowserUuid } from '@/lib/browser-uuid'
import { emptySplitGroup, insertSplitGroup } from '../slices/tabs/tabs-group-actions'
import { ownsGlobalSelection } from '../global-selection-owner'
import type { TerminalSlice, TerminalStoreGet, TerminalStoreSet } from './terminal-state'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'
import {
  recordCreatedTerminalTabInLayoutOwner,
  terminalTabCreateCommand,
  withMainTerminalFacts
} from './terminal-tab-create-through-layout-owner'
import type { AppState } from '../types'
import { normalizeTabStartupCommand } from './terminal-startup-queues'

export function createTerminalTabCreationActions(
  set: TerminalStoreSet,
  get: TerminalStoreGet,
  subscribe: (listener: (state: AppState) => void) => () => void
): Pick<TerminalSlice, 'createTab'> {
  return {
    createTab: (worktreeId, targetGroupId, shellOverride, options) => {
      let tab!: TerminalTab
      const split = options?.split
      const splitGroupId = split ? createBrowserUuid() : undefined
      set((current) => {
        const s =
          split && splitGroupId
            ? {
                ...current,
                ...insertSplitGroup(
                  current,
                  worktreeId,
                  split,
                  emptySplitGroup(worktreeId, splitGroupId)
                )
              }
            : current
        const requestedGroupId = splitGroupId ?? targetGroupId
        const orphanTerminalIds = getOrphanTerminalIds(s, worktreeId)
        const orphanCleanupPatch = buildOrphanTerminalCleanupPatch(s, worktreeId, orphanTerminalIds)
        const existing = (s.tabsByWorktree[worktreeId] ?? []).filter(
          (entry) => !orphanTerminalIds.has(entry.id)
        )
        // Trim ID hints: IPC can include empty IDs, which break pane-key routing.
        const trimmedHint = typeof options?.id === 'string' ? options.id.trim() : ''
        // Why: `web-terminal-` ids are reserved for mirrored host tabs, so an IPC-spread hint must not take one.
        const hintIsValid = options?.mirroredHostTab
          ? isValidMirroredHostTerminalTabId(trimmedHint)
          : isValidHostTerminalTabId(trimmedHint)
        const hintedId = trimmedHint.length > 0 && hintIsValid ? trimmedHint : undefined
        // Why: the caller's PTY routes agent status by this id, so a fresh id would orphan it and aliasing would corrupt another tab's.
        if (
          hintedId !== undefined &&
          Object.values(s.tabsByWorktree).some((tabs) =>
            tabs.some((entry) => entry.id === hintedId)
          )
        ) {
          throw new Error(`Terminal tab ${hintedId} already exists`)
        }
        const id = hintedId ?? createBrowserUuid()
        const requestedInitialLeafId =
          options?.initialLeafId && isTerminalLeafId(options.initialLeafId)
            ? options.initialLeafId
            : undefined
        // Why: name the first pane at creation so the saved layout is never empty; the pane mounts and spawns into this leaf.
        const initialLeafId = requestedInitialLeafId ?? createBrowserUuid()
        const shouldActivate = options?.activate !== false
        const nextOrdinal = getNextTerminalOrdinal(existing)
        const defaultTitle = `Terminal ${nextOrdinal}`
        const quickCommandLabel = options?.quickCommandLabel?.trim()
        const startupCwd = options?.startupCwd
        const facts = options?.executionFacts
        const { folder, createdShellOverride } = resolveTerminalCreatedShell(
          s,
          worktreeId,
          shellOverride,
          options,
          facts
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
          ...(options?.agentLaunchPane ? { agentLaunchPane: options.agentLaunchPane } : {}),
          // Tag click-driven spawn so bind cannot reorder Recent/Smart via activity/sortEpoch.
          ...(options?.pendingActivationSpawn ? { pendingActivationSpawn: true } : {})
        }
        // Switch point: a tab main already made is drawn with main's creation facts.
        if (ORCA_LAYOUT_OWNER_IS_MAIN) {
          tab = withMainTerminalFacts(tab)
        }
        if (options?.launchAgent === 'zcode') {
          // Why here: this is where a ZCode launch is first known, and it runs before the
          // pane connects, so the explanation can beat the stack trace to the screen.
          void warnIfZCodeCannotOpenSession()
        }
        const validTargetGroupId =
          requestedGroupId &&
          s.groupsByWorktree[worktreeId]?.some((group) => group.id === requestedGroupId)
            ? requestedGroupId
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
          ...(facts || folder ? { executionHostId: facts?.hostId ?? folder?.hostId } : {}),
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
          activeTabId:
            shouldActivate && ownsGlobalSelection(s, worktreeId)
              ? tab.id
              : orphanCleanupPatch.activeTabId,
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
            [tab.id]: singlePaneLayoutSnapshot(initialLeafId, options?.initialPtyId)
          }
        }
      })
      // Switch point: main writes the tab under these ids before any later command names it.
      if (ORCA_LAYOUT_OWNER_IS_MAIN) {
        recordCreatedTerminalTabInLayoutOwner(get(), terminalTabCreateCommand(get(), tab), {
          tab,
          store: { getState: get, setState: (patch) => set(patch), subscribe }
        })
      }
      if (options?.initialPtyId) {
        // Why: a tab born with a live PTY (CLI/runtime create) wakes the workspace like any other bind.
        clearWorktreeSleepIntent(worktreeId)
      }
      const shouldRecordInteraction =
        options?.recordInteraction ?? (!options?.pendingActivationSpawn && !options?.initialPtyId)
      if (shouldRecordInteraction) {
        get().recordFeatureInteraction?.('terminal-tabs')
      }
      if (splitGroupId) {
        get().recordFeatureInteraction?.('terminal-panes')
      }
      return tab
    }
  }
}
