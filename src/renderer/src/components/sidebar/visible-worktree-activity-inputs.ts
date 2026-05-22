import type { BrowserWorkspace, TerminalTab } from '../../../../shared/types'

type TerminalActivityTab = Pick<TerminalTab, 'id'>
type BrowserActivityTab = Pick<BrowserWorkspace, 'id'>

function haveSameIds<T extends { id: string }>(
  previous: readonly T[] | undefined,
  next: readonly { id: string }[]
): boolean {
  if (!previous || previous.length !== next.length) {
    return false
  }
  for (let index = 0; index < next.length; index++) {
    if (previous[index]?.id !== next[index]?.id) {
      return false
    }
  }
  return true
}

function projectIdTabs<T extends { id: string }, U extends { id: string }>(
  tabsByWorktree: Record<string, readonly T[]>,
  previousProjection: Record<string, U[]> | null
): { projection: Record<string, U[]>; unchanged: boolean } {
  const nextProjection: Record<string, U[]> = {}
  let unchanged =
    previousProjection !== null &&
    Object.keys(previousProjection).length === Object.keys(tabsByWorktree).length

  for (const [worktreeId, tabs] of Object.entries(tabsByWorktree)) {
    const previousTabs = previousProjection?.[worktreeId]
    if (haveSameIds(previousTabs, tabs)) {
      nextProjection[worktreeId] = previousTabs as U[]
      continue
    }
    unchanged = false
    nextProjection[worktreeId] = tabs.map((tab) => ({ id: tab.id }) as U)
  }

  return { projection: nextProjection, unchanged }
}

let cachedTerminalSource: Record<string, TerminalTab[]> | null = null
let cachedTerminalProjection: Record<string, TerminalActivityTab[]> | null = null

export function getVisibleWorktreeTerminalActivityTabs(
  tabsByWorktree: Record<string, TerminalTab[]>
): Record<string, TerminalActivityTab[]> {
  if (cachedTerminalSource === tabsByWorktree && cachedTerminalProjection) {
    return cachedTerminalProjection
  }
  const { projection, unchanged } = projectIdTabs(tabsByWorktree, cachedTerminalProjection)
  cachedTerminalSource = tabsByWorktree
  if (unchanged && cachedTerminalProjection) {
    return cachedTerminalProjection
  }
  cachedTerminalProjection = projection
  return projection
}

let cachedBrowserSource: Record<string, BrowserWorkspace[]> | null = null
let cachedBrowserProjection: Record<string, BrowserActivityTab[]> | null = null

export function getVisibleWorktreeBrowserActivityTabs(
  browserTabsByWorktree: Record<string, BrowserWorkspace[]>
): Record<string, BrowserActivityTab[]> {
  if (cachedBrowserSource === browserTabsByWorktree && cachedBrowserProjection) {
    return cachedBrowserProjection
  }
  const { projection, unchanged } = projectIdTabs(browserTabsByWorktree, cachedBrowserProjection)
  cachedBrowserSource = browserTabsByWorktree
  if (unchanged && cachedBrowserProjection) {
    return cachedBrowserProjection
  }
  cachedBrowserProjection = projection
  return projection
}
