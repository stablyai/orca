import type { Tab, TabGroup, TabGroupLayoutNode } from '../../../../shared/tab-types'
import type { WorkspaceSessionState } from '../../../../shared/workspace-session-state-types'
import { isValidTerminalTabId } from '../../../../shared/terminal-tab-id'
import { createBrowserUuid } from '@/lib/browser-uuid'
import type { HydratedTabState } from './tabs-hydration'

export function hydrateLegacyTabState(
  session: WorkspaceSessionState,
  validWorktreeIds: Set<string>
): HydratedTabState {
  const tabsByWorktree: Record<string, Tab[]> = {}
  const groupsByWorktree: Record<string, TabGroup[]> = {}
  const activeGroupIdByWorktree: Record<string, string> = {}
  const layoutByWorktree: Record<string, TabGroupLayoutNode> = {}

  for (const worktreeId of validWorktreeIds) {
    const terminalTabs = (session.tabsByWorktree[worktreeId] ?? []).filter((tab) =>
      isValidTerminalTabId(tab.id)
    )
    const editorFiles = session.openFilesByWorktree?.[worktreeId] ?? []

    if (terminalTabs.length === 0 && editorFiles.length === 0) {
      continue
    }

    const groupId = createBrowserUuid()
    const tabs: Tab[] = []
    const tabOrder: string[] = []

    for (const tt of terminalTabs) {
      tabs.push({
        id: tt.id,
        entityId: tt.id,
        groupId,
        worktreeId,
        contentType: 'terminal',
        label: tt.title,
        ...(tt.quickCommandLabel?.trim() ? { quickCommandLabel: tt.quickCommandLabel.trim() } : {}),
        ...(tt.generatedTitle?.trim() ? { generatedLabel: tt.generatedTitle.trim() } : {}),
        customLabel: tt.customTitle,
        color: tt.color,
        sortOrder: tt.sortOrder,
        createdAt: tt.createdAt,
        isPreview: false,
        isPinned: false
      })
      tabOrder.push(tt.id)
    }

    for (const ef of editorFiles) {
      tabs.push({
        id: ef.filePath,
        entityId: ef.filePath,
        groupId,
        worktreeId,
        contentType: 'editor',
        label: ef.relativePath,
        customLabel: null,
        color: null,
        sortOrder: tabs.length,
        createdAt: Date.now(),
        isPreview: ef.isPreview,
        isPinned: false
      })
      tabOrder.push(ef.filePath)
    }

    const activeTabType = session.activeTabTypeByWorktree?.[worktreeId] ?? 'terminal'
    let activeTabId: string | null = null
    if (activeTabType === 'editor') {
      activeTabId = session.activeFileIdByWorktree?.[worktreeId] ?? null
    } else {
      // Why: honor this worktree's own remembered terminal before the global
      // active tab. The global session.activeTabId only names the last-focused
      // worktree's tab, so using it here reset every other worktree to its
      // first terminal on restart.
      const rememberedTabId = session.activeTabIdByWorktree?.[worktreeId]
      if (rememberedTabId && terminalTabs.some((t) => t.id === rememberedTabId)) {
        activeTabId = rememberedTabId
      } else if (session.activeTabId && terminalTabs.some((t) => t.id === session.activeTabId)) {
        activeTabId = session.activeTabId
      }
    }
    if (activeTabId && !tabs.some((t) => t.id === activeTabId)) {
      activeTabId = tabs[0]?.id ?? null
    }

    tabsByWorktree[worktreeId] = tabs
    groupsByWorktree[worktreeId] = [
      {
        id: groupId,
        worktreeId,
        activeTabId,
        tabOrder,
        // Why: legacy sessions don't persist MRU; seed with the active tab so
        // the first close after a legacy restore still behaves MRU-ish (falls
        // back to neighbor selection if only one tab is in the stack).
        recentTabIds: activeTabId ? [activeTabId] : []
      }
    ]
    activeGroupIdByWorktree[worktreeId] = groupId
    layoutByWorktree[worktreeId] = { type: 'leaf', groupId }
  }

  return {
    unifiedTabsByWorktree: tabsByWorktree,
    groupsByWorktree,
    activeGroupIdByWorktree,
    layoutByWorktree
  }
}
