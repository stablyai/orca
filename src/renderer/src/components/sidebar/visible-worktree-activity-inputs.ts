import type { BrowserWorkspace, TerminalTab } from '../../../../shared/types'

export type TerminalActivityTab = Pick<TerminalTab, 'id'>
export type BrowserActivityTab = Pick<BrowserWorkspace, 'id'>
export type WorktreeSectionTerminalActivityTab = Pick<TerminalTab, 'id' | 'title'>

function haveSameProjection<T, U>(
  previous: readonly U[] | undefined,
  next: readonly T[],
  isSame: (previousTab: U, nextTab: T) => boolean
): boolean {
  if (!previous || previous.length !== next.length) {
    return false
  }
  for (let index = 0; index < next.length; index++) {
    const previousTab = previous[index]
    if (!previousTab || !isSame(previousTab, next[index])) {
      return false
    }
  }
  return true
}

function projectTabs<T, U>(
  tabsByWorktree: Record<string, readonly T[]>,
  previousProjection: Record<string, U[]> | null,
  projectTab: (tab: T) => U,
  isSame: (previousTab: U, nextTab: T) => boolean
): { projection: Record<string, U[]>; unchanged: boolean } {
  const nextProjection: Record<string, U[]> = {}
  let unchanged =
    previousProjection !== null &&
    Object.keys(previousProjection).length === Object.keys(tabsByWorktree).length

  for (const [worktreeId, tabs] of Object.entries(tabsByWorktree)) {
    const previousTabs = previousProjection?.[worktreeId]
    if (haveSameProjection(previousTabs, tabs, isSame)) {
      nextProjection[worktreeId] = previousTabs as U[]
      continue
    }
    unchanged = false
    nextProjection[worktreeId] = tabs.map(projectTab)
  }

  return { projection: nextProjection, unchanged }
}

function projectIdTabs<T extends { id: string }, U extends { id: string }>(
  tabsByWorktree: Record<string, readonly T[]>,
  previousProjection: Record<string, U[]> | null
): { projection: Record<string, U[]>; unchanged: boolean } {
  return projectTabs(
    tabsByWorktree,
    previousProjection,
    (tab) => ({ id: tab.id }) as U,
    (previousTab, nextTab) => previousTab.id === nextTab.id
  )
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

let cachedSectionTerminalSource: Record<string, TerminalTab[]> | null = null
let cachedSectionTerminalProjection: Record<string, WorktreeSectionTerminalActivityTab[]> | null =
  null

export function getWorktreeSectionTerminalActivityTabs(
  tabsByWorktree: Record<string, TerminalTab[]>
): Record<string, WorktreeSectionTerminalActivityTab[]> {
  if (cachedSectionTerminalSource === tabsByWorktree && cachedSectionTerminalProjection) {
    return cachedSectionTerminalProjection
  }
  const { projection, unchanged } = projectTabs(
    tabsByWorktree,
    cachedSectionTerminalProjection,
    (tab) => ({ id: tab.id, title: tab.title }),
    (previousTab, nextTab) => previousTab.id === nextTab.id && previousTab.title === nextTab.title
  )
  cachedSectionTerminalSource = tabsByWorktree
  if (unchanged && cachedSectionTerminalProjection) {
    return cachedSectionTerminalProjection
  }
  cachedSectionTerminalProjection = projection
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
