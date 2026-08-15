import {
  isRuntimePathAbsolute,
  isWindowsAbsolutePathLike,
  normalizeRuntimePathForComparison,
  normalizeRuntimePathSeparators,
  resolveRuntimePath
} from './cross-platform-path'
import type { GlobalSettings, OrcaWorkspaceLayout } from './global-settings-types'
import type { Repo } from './repo-types'
import { isNestedWorktreeLocation } from './worktree-location-mode'
import { parseWslUncPath } from './wsl-paths'

export function buildKnownOrcaWorkspaceLayouts(
  settings: Pick<GlobalSettings, 'workspaceDir' | 'nestWorkspaces' | 'workspaceDirHistory'> &
    Partial<Pick<GlobalSettings, 'defaultWorktreeLocationMode'>>,
  repo?: Pick<Repo, 'path' | 'connectionId' | 'worktreeBasePath' | 'worktreeLocationMode'>
): OrcaWorkspaceLayout[] {
  const layouts: OrcaWorkspaceLayout[] = []
  if (repo && isNestedWorktreeLocation(repo, settings)) {
    layouts.push({
      path: resolveRuntimePath(repo.path, '.worktrees'),
      nestWorkspaces: false,
      worktreeLocationMode: 'nested'
    })
  }
  const repoBasePath = getRepoWorktreeBasePath(repo)
  if (repo && repoBasePath) {
    layouts.push({
      path: resolveWorkspaceLayoutPath(repo.path, repoBasePath),
      nestWorkspaces: settings.nestWorkspaces
    })
  }
  if (settings.workspaceDir && shouldIncludeWorkspaceLayout(repo, settings.workspaceDir)) {
    layouts.push({
      path: repo
        ? resolveWorkspaceLayoutPath(repo.path, settings.workspaceDir)
        : settings.workspaceDir,
      nestWorkspaces: settings.nestWorkspaces
    })
    appendWorkspaceLayouts(
      layouts,
      (settings.workspaceDirHistory ?? [])
        .filter((layout) => shouldIncludeWorkspaceLayout(repo, layout.path))
        .map((layout) => ({
          ...layout,
          path: repo ? resolveWorkspaceLayoutPath(repo.path, layout.path) : layout.path
        }))
    )
  }

  const wslLayouts = repo ? buildWslWorkspaceLayouts(repo.path, settings) : []
  appendWorkspaceLayouts(layouts, wslLayouts)

  const seen = new Set<string>()
  return layouts.filter((layout) => {
    const key = `${normalizeRuntimePathForComparison(layout.path)}:${layout.nestWorkspaces}`
    if (seen.has(key)) {
      return false
    }
    seen.add(key)
    return Boolean(layout.path)
  })
}

function appendWorkspaceLayouts(
  target: OrcaWorkspaceLayout[],
  source: readonly OrcaWorkspaceLayout[]
): void {
  // Why: workspace history is persisted user data and can grow large enough
  // for `push(...source)` to exceed the JavaScript call argument limit.
  for (const layout of source) {
    target.push(layout)
  }
}

function getRepoWorktreeBasePath(
  repo: Pick<Repo, 'worktreeBasePath'> | undefined
): string | undefined {
  const trimmed = repo?.worktreeBasePath?.trim()
  return trimmed || undefined
}

function resolveWorkspaceLayoutPath(repoPath: string, layoutPath: string): string {
  return isRuntimePathAbsoluteForRepo(repoPath, layoutPath)
    ? normalizeRuntimePathSeparators(layoutPath)
    : resolveRuntimePath(repoPath, layoutPath)
}

function isRuntimePathAbsoluteForRepo(repoPath: string, layoutPath: string): boolean {
  const pathFlavor =
    isWindowsAbsolutePathLike(repoPath) || isWindowsAbsolutePathLike(layoutPath)
      ? 'windows'
      : 'posix'
  return isRuntimePathAbsolute(layoutPath, pathFlavor)
}

function shouldIncludeWorkspaceLayout(
  repo: Pick<Repo, 'path' | 'connectionId'> | undefined,
  layoutPath: string
): boolean {
  return !repo?.connectionId || !isRuntimePathAbsoluteForRepo(repo.path, layoutPath)
}

function buildWslWorkspaceLayouts(
  repoPath: string,
  settings: Pick<GlobalSettings, 'nestWorkspaces' | 'workspaceDirHistory'>
): OrcaWorkspaceLayout[] {
  const parsed = parseWslUncPath(repoPath)
  if (!parsed) {
    return []
  }
  const homeMatch = parsed.linuxPath.match(/^\/home\/[^/]+(?:\/|$)/)
  const linuxHome = homeMatch?.[0].replace(/\/$/, '')
  if (!linuxHome) {
    return []
  }
  const root = `//wsl.localhost/${parsed.distro}${linuxHome}/orca/workspaces`
  const historicalModes = (settings.workspaceDirHistory ?? []).map(
    (layout) => layout.nestWorkspaces
  )
  const modes = [settings.nestWorkspaces, ...historicalModes]
  return [...new Set(modes)].map((nestWorkspaces) => ({ path: root, nestWorkspaces }))
}
