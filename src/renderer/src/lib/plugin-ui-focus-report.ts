import type { WorkspaceVisibleTabType } from '../../../shared/tab-types'
import type { PluginFocusedSurfaceKind } from '../../../shared/plugins/plugin-focused-surface'
import type { PluginUiFocusReport } from '../../../shared/plugins/plugin-focused-surface'

const COMMAND_PALETTE_MODALS = new Set(['worktree-palette', 'quick-open'])

export type PluginUiFocusViewState = {
  windowFocused: boolean
  activeModal?: string | null
  activeTabType?: WorkspaceVisibleTabType | null
  activeWorktreeId?: string | null
  unifiedTabsByWorktree?: Record<
    string,
    {
      id: string
      groupId: string
      label: string
      customLabel: string | null
      generatedLabel?: string | null
    }[]
  >
  groupsByWorktree?: Record<string, { id: string; activeTabId: string | null }[]>
  activeGroupIdByWorktree?: Record<string, string | undefined>
}

export function derivePluginUiFocusReport(state: PluginUiFocusViewState): PluginUiFocusReport {
  if (!state.windowFocused) {
    return { windowFocused: false }
  }
  if (state.activeModal && COMMAND_PALETTE_MODALS.has(state.activeModal)) {
    return {
      windowFocused: true,
      kind: 'command-palette',
      title: null,
      ...focusJoinKeys(state, 'command-palette')
    }
  }
  const kind = kindFromVisibleTabType(state.activeTabType)
  if (!kind) {
    return { windowFocused: true }
  }
  return {
    windowFocused: true,
    kind,
    title: activeTabTitle(state),
    ...focusJoinKeys(state, kind)
  }
}

function focusJoinKeys(
  state: PluginUiFocusViewState,
  kind: PluginFocusedSurfaceKind
): Pick<PluginUiFocusReport, 'worktreeId' | 'agentId'> {
  const worktreeId = state.activeWorktreeId?.trim() || undefined
  if (kind !== 'agent') {
    return worktreeId ? { worktreeId } : {}
  }
  return {
    ...(worktreeId ? { worktreeId } : {}),
    agentId: activeTab(state)?.id ?? null
  }
}

function kindFromVisibleTabType(
  type: WorkspaceVisibleTabType | null | undefined
): PluginFocusedSurfaceKind | null {
  if (!type) {
    return null
  }
  switch (type) {
    case 'terminal':
      return 'terminal'
    case 'editor':
      return 'editor'
    case 'agent-session':
      return 'agent'
    case 'browser':
      return 'browser'
    case 'simulator':
      return 'simulator'
  }
}

function activeTab(
  state: PluginUiFocusViewState
): NonNullable<PluginUiFocusViewState['unifiedTabsByWorktree']>[string][number] | null {
  const worktreeId = state.activeWorktreeId
  if (!worktreeId) {
    return null
  }
  const groups = state.groupsByWorktree?.[worktreeId] ?? []
  const preferredGroupId = state.activeGroupIdByWorktree?.[worktreeId]
  const group =
    (preferredGroupId ? groups.find((entry) => entry.id === preferredGroupId) : null) ??
    groups[0] ??
    null
  if (!group?.activeTabId) {
    return null
  }
  return (
    (state.unifiedTabsByWorktree?.[worktreeId] ?? []).find(
      (entry) => entry.id === group.activeTabId
    ) ?? null
  )
}

function activeTabTitle(state: PluginUiFocusViewState): string | null {
  const tab = activeTab(state)
  if (!tab) {
    return null
  }
  return tab.customLabel ?? tab.generatedLabel ?? tab.label ?? null
}
