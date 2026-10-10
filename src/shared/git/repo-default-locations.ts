import { getDefaultWorkspaceDir } from '../constants'
import { normalizeRuntimePathForComparison } from '../cross-platform-path'
import { LOCAL_EXECUTION_HOST_ID } from '../execution-host'
import { getEffectiveHostSetting } from '../host-setting-overrides'
import type { GlobalSettings } from '../global-settings-types'

export type RepoDefaultLocationSettings = {
  workspaceDir?: string | null
  hostSettingOverrides?: GlobalSettings['hostSettingOverrides']
}

export function getDefaultCloneParent(workspaceDir: string): string {
  if (!workspaceDir) {
    return ''
  }

  const trimmed = workspaceDir.replace(/[\\/]+$/, '')
  if (!trimmed) {
    return workspaceDir
  }

  const separatorIndex = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  const lastSegment = separatorIndex === -1 ? trimmed : trimmed.slice(separatorIndex + 1)

  if (lastSegment !== 'workspaces') {
    return workspaceDir
  }

  // Why: default Orca worktrees live under "workspaces"; clones should sit beside that tree.
  const parent = separatorIndex === -1 ? '' : trimmed.slice(0, separatorIndex)
  if (parent === '' && trimmed.startsWith('/')) {
    return '/'
  }
  if (/^[A-Za-z]:$/.test(parent)) {
    return `${parent}${trimmed[separatorIndex]}`
  }
  return parent
}

/** The workspace directory the local host actually uses: a per-host
 *  `defaultWorktreeLocation` override wins over the client `workspaceDir`. */
export function resolveEffectiveLocalWorkspaceDir(
  settings: RepoDefaultLocationSettings | null | undefined
): string {
  return getEffectiveHostSetting(
    settings,
    LOCAL_EXECUTION_HOST_ID,
    'defaultWorktreeLocation',
    settings?.workspaceDir ?? ''
  ).trim()
}

function joinUnderHome(home: string, ...segments: string[]): string {
  // Renderer-safe join: match the home path's separator style (no node:path here).
  const separator = home.includes('\\') && !home.includes('/') ? '\\' : '/'
  return [home.replace(/[\\/]+$/, ''), ...segments].join(separator)
}

/** Same default-destination policy as the desktop Add Repo clone flow; shared so
 *  mobile-initiated clones (which cannot type host paths) resolve identically.
 *  A set workspace directory wins as-is (workspaces suffix stripped); otherwise
 *  clones fall back to the home-based default projects directory. */
export function resolveDefaultCloneDestination(args: {
  settings: RepoDefaultLocationSettings | null | undefined
  home: string
}): string {
  const effective = resolveEffectiveLocalWorkspaceDir(args.settings)
  if (effective) {
    return getDefaultCloneParent(effective)
  }
  return joinUnderHome(args.home, 'orca', 'projects')
}

/** Where the "Create new project" parent defaults to — the same policy the
 *  desktop create flow uses.
 *
 *  Why the untouched default does not count: `workspaceDir` is never blank — new
 *  installs seed it with `~/orca/workspaces`. Treating that seeded value as a
 *  choice would silently relocate every existing user's projects into the
 *  worktree root, where each project would then host its own worktrees inside
 *  its working tree. */
export function resolveDefaultCreateProjectParent(args: {
  settings: RepoDefaultLocationSettings | null | undefined
  home: string
}): string {
  const configured = resolveEffectiveLocalWorkspaceDir(args.settings)
  const isUntouchedDefault =
    normalizeRuntimePathForComparison(configured) ===
    normalizeRuntimePathForComparison(getDefaultWorkspaceDir(args.home))
  if (configured && !isUntouchedDefault) {
    return configured
  }
  return joinUnderHome(args.home, 'orca', 'projects')
}
