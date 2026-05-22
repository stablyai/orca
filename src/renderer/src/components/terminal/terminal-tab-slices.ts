import type { TerminalTab } from '../../../../shared/types'

export type TerminalTabSlices = {
  activeTabs: TerminalTab[]
  mountedTabsByWorktree: Record<string, TerminalTab[]>
}

const EMPTY_TERMINAL_TABS: TerminalTab[] = []
let cachedTabsByWorktree: Record<string, TerminalTab[]> | null = null
let cachedMountedIdsKey = ''
let cachedActiveWorktreeId: string | null = null
let cachedSlices: TerminalTabSlices = {
  activeTabs: EMPTY_TERMINAL_TABS,
  mountedTabsByWorktree: {}
}

function mountedIdsKey(mountedWorktreeIds: ReadonlySet<string>): string {
  return [...mountedWorktreeIds].sort().join('\0')
}

function sameMountedTabs(
  left: Record<string, TerminalTab[]>,
  right: Record<string, TerminalTab[]>
): boolean {
  const leftKeys = Object.keys(left)
  const rightKeys = Object.keys(right)
  return leftKeys.length === rightKeys.length && leftKeys.every((key) => left[key] === right[key])
}

export function getTerminalTabSlices(
  tabsByWorktree: Record<string, TerminalTab[]>,
  mountedWorktreeIds: ReadonlySet<string>,
  activeWorktreeId: string | null
): TerminalTabSlices {
  const nextMountedIdsKey = mountedIdsKey(mountedWorktreeIds)
  if (
    tabsByWorktree === cachedTabsByWorktree &&
    nextMountedIdsKey === cachedMountedIdsKey &&
    activeWorktreeId === cachedActiveWorktreeId
  ) {
    return cachedSlices
  }

  const activeTabs = activeWorktreeId
    ? (tabsByWorktree[activeWorktreeId] ?? EMPTY_TERMINAL_TABS)
    : EMPTY_TERMINAL_TABS
  const mountedTabsByWorktree: Record<string, TerminalTab[]> = {}
  for (const worktreeId of mountedWorktreeIds) {
    mountedTabsByWorktree[worktreeId] = tabsByWorktree[worktreeId] ?? EMPTY_TERMINAL_TABS
  }

  cachedTabsByWorktree = tabsByWorktree
  cachedMountedIdsKey = nextMountedIdsKey
  cachedActiveWorktreeId = activeWorktreeId
  if (
    activeTabs === cachedSlices.activeTabs &&
    sameMountedTabs(mountedTabsByWorktree, cachedSlices.mountedTabsByWorktree)
  ) {
    return cachedSlices
  }

  // Why: Terminal renders only the active titlebar and mounted pane trees.
  // Ignore tab-array churn for unmounted worktrees so background metadata
  // updates do not rerender xterm while the user is typing.
  cachedSlices = { activeTabs, mountedTabsByWorktree }
  return cachedSlices
}
