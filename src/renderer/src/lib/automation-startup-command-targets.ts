import type {
  AutomationLaunchTarget,
  AutomationRunTrigger,
  AutomationTrigger
} from '../../../shared/automations-types'
import type { TerminalTab, Worktree } from '../../../shared/types'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../shared/constants'

export function getStartupCommandTitle(name: string): string {
  const trimmed = name.trim()
  return `Startup: ${trimmed || 'Automation'}`
}

export function resolveTerminalCommandLaunchTarget(args: {
  runTrigger: AutomationRunTrigger
  automationTrigger: AutomationTrigger
  automationLaunchTarget: AutomationLaunchTarget
}): AutomationLaunchTarget {
  return args.runTrigger === 'app_launch' || args.automationTrigger === 'app_launch'
    ? args.automationLaunchTarget
    : 'selected_worktree'
}

function hasStartupCommandTab(tabs: TerminalTab[] | undefined, duplicateTitle: string): boolean {
  return (tabs ?? []).some(
    (tab) => tab.customTitle === duplicateTitle || tab.title === duplicateTitle
  )
}

export function resolveStartupCommandTargets(args: {
  projectId: string
  launchTarget: AutomationLaunchTarget
  worktrees: Worktree[]
  tabsByWorktree: Record<string, TerminalTab[]>
  selectedWorktreeId?: string | null
  duplicateTitle?: string | null
}): Worktree[] {
  const projectWorktrees = args.worktrees.filter((worktree) => worktree.repoId === args.projectId)
  const mainWorktree = projectWorktrees.find((worktree) => worktree.isMainWorktree) ?? null
  const openWorktreeIds = new Set(
    Object.entries(args.tabsByWorktree)
      .filter(([, tabs]) => tabs.length > 0)
      .map(([worktreeId]) => worktreeId)
  )
  const candidates = (() => {
    switch (args.launchTarget) {
      case 'main':
        return mainWorktree ? [mainWorktree] : []
      case 'open_worktrees':
        return projectWorktrees.filter((worktree) => openWorktreeIds.has(worktree.id))
      case 'main_and_open_worktrees':
        return [
          ...(mainWorktree ? [mainWorktree] : []),
          ...projectWorktrees.filter(
            (worktree) => openWorktreeIds.has(worktree.id) && worktree.id !== mainWorktree?.id
          )
        ]
      case 'selected_worktree':
        return projectWorktrees.filter((worktree) => worktree.id === args.selectedWorktreeId)
      // Why: 'floating' is resolved by resolveGlobalStartupCommandTarget and
      // should never reach resolveStartupCommandTargets.
      case 'floating':
        return []
    }
  })()

  const seen = new Set<string>()
  return candidates.filter((worktree) => {
    if (seen.has(worktree.id)) {
      return false
    }
    seen.add(worktree.id)
    return args.duplicateTitle
      ? !hasStartupCommandTab(args.tabsByWorktree[worktree.id], args.duplicateTitle)
      : true
  })
}

export function resolveGlobalStartupCommandTarget(args: {
  globalCwd?: string | null
  tabsByWorktree: Record<string, TerminalTab[]>
  duplicateTitle?: string | null
}): { worktreeId: string; displayName: string; cwd: string } | null {
  const cwd = args.globalCwd?.trim()
  if (!cwd) {
    return null
  }
  if (
    args.duplicateTitle &&
    hasStartupCommandTab(args.tabsByWorktree[FLOATING_TERMINAL_WORKTREE_ID], args.duplicateTitle)
  ) {
    return null
  }
  return {
    worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
    displayName: 'Global',
    cwd
  }
}

export function resolveTrustedGlobalStartupCommandCwd(args: {
  configuredCwd: string
  resolvedCwd: string
}): string | null {
  const configuredCwd = args.configuredCwd.trim()
  const resolvedCwd = args.resolvedCwd.trim()
  return configuredCwd && resolvedCwd === configuredCwd ? resolvedCwd : null
}
