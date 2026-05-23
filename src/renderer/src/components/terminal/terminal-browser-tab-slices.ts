import type { BrowserTab } from '../../../../shared/types'

export type TerminalBrowserTabSlices = {
  activeBrowserTabs: BrowserTab[]
  mountedBrowserTabsByWorktree: Record<string, BrowserTab[]>
}

const EMPTY_BROWSER_TABS: BrowserTab[] = []
let cachedBrowserTabsByWorktree: Record<string, BrowserTab[]> | null = null
let cachedMountedIdsKey = ''
let cachedActiveWorktreeId: string | null = null
let cachedSlices: TerminalBrowserTabSlices = {
  activeBrowserTabs: EMPTY_BROWSER_TABS,
  mountedBrowserTabsByWorktree: {}
}

function mountedIdsKey(mountedWorktreeIds: ReadonlySet<string>): string {
  return [...mountedWorktreeIds].sort().join('\0')
}

function sameMountedBrowserTabs(
  left: Record<string, BrowserTab[]>,
  right: Record<string, BrowserTab[]>
): boolean {
  const leftKeys = Object.keys(left)
  const rightKeys = Object.keys(right)
  return leftKeys.length === rightKeys.length && leftKeys.every((key) => left[key] === right[key])
}

export function getTerminalBrowserTabSlices(
  browserTabsByWorktree: Record<string, BrowserTab[]>,
  mountedWorktreeIds: ReadonlySet<string>,
  activeWorktreeId: string | null
): TerminalBrowserTabSlices {
  const nextMountedIdsKey = mountedIdsKey(mountedWorktreeIds)
  if (
    browserTabsByWorktree === cachedBrowserTabsByWorktree &&
    nextMountedIdsKey === cachedMountedIdsKey &&
    activeWorktreeId === cachedActiveWorktreeId
  ) {
    return cachedSlices
  }

  const activeBrowserTabs = activeWorktreeId
    ? (browserTabsByWorktree[activeWorktreeId] ?? EMPTY_BROWSER_TABS)
    : EMPTY_BROWSER_TABS
  const mountedBrowserTabsByWorktree: Record<string, BrowserTab[]> = {}
  for (const worktreeId of mountedWorktreeIds) {
    mountedBrowserTabsByWorktree[worktreeId] =
      browserTabsByWorktree[worktreeId] ?? EMPTY_BROWSER_TABS
  }

  cachedBrowserTabsByWorktree = browserTabsByWorktree
  cachedMountedIdsKey = nextMountedIdsKey
  cachedActiveWorktreeId = activeWorktreeId
  if (
    activeBrowserTabs === cachedSlices.activeBrowserTabs &&
    sameMountedBrowserTabs(mountedBrowserTabsByWorktree, cachedSlices.mountedBrowserTabsByWorktree)
  ) {
    return cachedSlices
  }

  // Why: hidden BrowserPanes are retained only for mounted worktrees. Avoid
  // rendering or resubscribing the terminal surface when browser tabs in
  // unvisited worktrees restore or refresh in the background.
  cachedSlices = { activeBrowserTabs, mountedBrowserTabsByWorktree }
  return cachedSlices
}
