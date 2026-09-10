import type { AppState } from '../../types'
import type {
  BrowserCookieImportResult,
  BrowserPage,
  BrowserSessionProfile,
  DefaultBrowserSessionProfileIdByHostId
} from '../../../../../shared/browser-workspace-types'
import {
  getSettingsFocusedExecutionHostId,
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId,
  toRuntimeExecutionHostId,
  type ExecutionHostId
} from '../../../../../shared/execution-host'
import type {
  BrowserSlice,
  BrowserCookieImportExecutionResult,
  RemoteBrowserPageHandle
} from './browser-slice-contract'
import { getExecutionHostIdForWorktree } from '@/lib/worktree-runtime-owner'

/** Rebuild the remote page handles a restored session implies. No placement is seeded: the
 *  persisted generations belong to the host lease that died with the last run, and the first host
 *  snapshot is what supplies the live one.
 *
 *  Client-hosted rows only. A server-hosted page lives on the runtime, which may have restarted or
 *  been redeployed while this desktop was closed; a seeded handle sends its pane down the adopt
 *  branch, and the browser_tab_not_found that comes back deletes the row. With no handle the pane
 *  creates a fresh page at the URL the row persisted, which is what the user left behind. */
export function buildRestoredRemoteBrowserPageHandles(
  browserPagesByWorkspace: Record<string, BrowserPage[]>
): Record<string, RemoteBrowserPageHandle> {
  const handles: Record<string, RemoteBrowserPageHandle> = {}
  for (const pages of Object.values(browserPagesByWorkspace)) {
    for (const page of pages) {
      if (
        !page.browserRuntimeEnvironmentId ||
        !page.remoteBrowserPageId ||
        !page.remoteBrowserPageClientHosted
      ) {
        continue
      }
      handles[page.id] = {
        environmentId: page.browserRuntimeEnvironmentId,
        remotePageId: page.remoteBrowserPageId,
        restoredFromSession: true,
        restoredClientHosted: true
      }
    }
  }
  return handles
}

export function retainCookieImportExecutionHost(
  result: BrowserCookieImportResult,
  executionHostId: ExecutionHostId,
  executionHostLabel: string,
  executionMachine: 'client' | 'remote'
): BrowserCookieImportExecutionResult {
  return {
    ...result,
    executionHostId,
    executionHostLabel,
    executionMachine,
    executionRemoteEnvironment: parseExecutionHostId(executionHostId)?.kind === 'runtime'
  }
}

export function getBrowserSettingsHostId(
  state: Pick<AppState, 'browserSessionHostIdOverride' | 'settings'>
): ExecutionHostId {
  return state.browserSessionHostIdOverride ?? getSettingsFocusedExecutionHostId(state.settings)
}

export function getBrowserSettingsRuntimeEnvironmentId(
  state: Pick<AppState, 'browserSessionHostIdOverride' | 'settings'>
): string | null {
  const parsed = parseExecutionHostId(getBrowserSettingsHostId(state))
  return parsed?.kind === 'runtime' ? parsed.environmentId : null
}

export function getBrowserWorktreeHostId(state: AppState, worktreeId: string): ExecutionHostId {
  return getExecutionHostIdForWorktree(state, worktreeId)
}

export function getBrowserSessionProfileHostId(
  state: AppState,
  worktreeId: string,
  browserRuntimeEnvironmentId: string | null | undefined
): ExecutionHostId {
  if (browserRuntimeEnvironmentId === null) {
    return LOCAL_EXECUTION_HOST_ID
  }
  if (browserRuntimeEnvironmentId !== undefined) {
    const runtimeEnvironmentId = browserRuntimeEnvironmentId.trim()
    return runtimeEnvironmentId
      ? toRuntimeExecutionHostId(runtimeEnvironmentId)
      : LOCAL_EXECUTION_HOST_ID
  }
  return getBrowserWorktreeHostId(state, worktreeId)
}

export function isLocalBrowserPageOwner(
  state: AppState,
  worktreeId: string,
  browserRuntimeEnvironmentId: string | null | undefined
): boolean {
  return (
    parseExecutionHostId(
      getBrowserSessionProfileHostId(state, worktreeId, browserRuntimeEnvironmentId)
    )?.kind !== 'runtime'
  )
}

export function profileListByHostUpdate(
  state: Pick<
    AppState,
    'browserSessionHostIdOverride' | 'browserSessionProfilesByHostId' | 'settings'
  >,
  profiles: BrowserSessionProfile[],
  hostId: ExecutionHostId = getBrowserSettingsHostId(state)
): Partial<BrowserSlice> {
  return {
    ...(getBrowserSettingsHostId(state) === hostId ? { browserSessionProfiles: profiles } : {}),
    browserSessionProfilesByHostId: {
      ...state.browserSessionProfilesByHostId,
      [hostId]: profiles
    }
  }
}

export function getBrowserProfilesForHost(
  state: AppState,
  hostId: ExecutionHostId
): BrowserSessionProfile[] {
  return (
    state.browserSessionProfilesByHostId[hostId] ??
    (getBrowserSettingsHostId(state) === hostId ? state.browserSessionProfiles : [])
  )
}

export function getDefaultBrowserProfileForHost(
  state: AppState,
  hostId: ExecutionHostId
): string | null {
  // Why key presence and not ??: an explicit Default is stored as null, and it persists now,
  // so treating it as "nothing stored" would make this host inherit the shown host's profile
  // on every launch instead of just until the next one.
  if (hostId in state.defaultBrowserSessionProfileIdByHostId) {
    return state.defaultBrowserSessionProfileIdByHostId[hostId] ?? null
  }
  return getBrowserSettingsHostId(state) === hostId ? state.defaultBrowserSessionProfileId : null
}

// Why derive the scalar here: Settings → Browser reads it for the host it is showing, so a
// restored map that left it null would still paint Default after a relaunch.
export function hydratedDefaultBrowserSessionProfileSelection(
  state: Pick<AppState, 'browserSessionHostIdOverride' | 'settings'>,
  persisted: unknown
): {
  defaultBrowserSessionProfileId: string | null
  defaultBrowserSessionProfileIdByHostId: DefaultBrowserSessionProfileIdByHostId
} {
  const byHostId = (persisted ?? {}) as DefaultBrowserSessionProfileIdByHostId
  return {
    defaultBrowserSessionProfileId: byHostId[getBrowserSettingsHostId(state)] ?? null,
    defaultBrowserSessionProfileIdByHostId: byHostId
  }
}

// Why: a deleted profile must not stay the persisted selection, or the next launch restores
// a profile that no longer exists and the pane silently falls back to Default anyway.
export function clearedDefaultBrowserProfileForHostUpdate(
  state: AppState,
  hostId: ExecutionHostId,
  deletedProfileId: string
): Partial<BrowserSlice> {
  const wasSelectedOnThisHost = getDefaultBrowserProfileForHost(state, hostId) === deletedProfileId
  if (!wasSelectedOnThisHost) {
    return {}
  }

  const update: Partial<BrowserSlice> = {
    defaultBrowserSessionProfileIdByHostId: {
      ...state.defaultBrowserSessionProfileIdByHostId,
      [hostId]: null
    }
  }

  // The scalar only mirrors the host Settings is showing. Today's only caller deletes
  // on exactly that host, so this always fires; the guard keeps a future caller that
  // deletes elsewhere from blanking the pane.
  if (getBrowserSettingsHostId(state) === hostId) {
    update.defaultBrowserSessionProfileId = null
  }
  return update
}

export function browserImportStateForHostUpdate(
  state: AppState,
  hostId: ExecutionHostId,
  browserSessionImportState: BrowserSlice['browserSessionImportState']
): Partial<BrowserSlice> {
  return getBrowserSettingsHostId(state) === hostId ? { browserSessionImportState } : {}
}

export function getFallbackTabTypeForWorktree(
  worktreeId: string,
  openFiles: AppState['openFiles'],
  terminalTabsByWorktree: AppState['tabsByWorktree'],
  browserTabsByWorktree?: AppState['browserTabsByWorktree']
): AppState['activeTabType'] {
  if (openFiles.some((file) => file.worktreeId === worktreeId)) {
    return 'editor'
  }
  if ((browserTabsByWorktree?.[worktreeId] ?? []).length > 0) {
    return 'browser'
  }
  if ((terminalTabsByWorktree[worktreeId] ?? []).length > 0) {
    return 'terminal'
  }
  return 'terminal'
}
