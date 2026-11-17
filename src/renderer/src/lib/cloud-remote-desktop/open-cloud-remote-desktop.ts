import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store/index'
import type { AppState } from '@/store/types'
import { activateAndRevealWorkspace } from '@/lib/workspace/activation/worktree-activation'
import {
  CLOUD_REMOTE_DESKTOP_PENDING_URL,
  isCloudRemoteDesktopTabUrl,
  type CloudRemoteDesktopResult
} from '../../../../shared/hosted-sandbox/cloud-remote-desktop'

/** Starts the sandbox's desktop and forwards it here; never throws. */
export function requestCloudRemoteDesktop(
  environmentId: string
): Promise<CloudRemoteDesktopResult> {
  const open = window.api?.ephemeralVm?.openCloudRemoteDesktop
  if (typeof open !== 'function') {
    return Promise.resolve({ ok: false, code: 'unavailable' })
  }
  return open({ environmentId })
    .then((value) => value ?? { ok: false as const, code: 'unavailable' as const })
    .catch(() => ({ ok: false as const, code: 'unavailable' as const }))
}

/** The workspace's remote desktop tab (there is at most one), or null. */
export function selectRemoteDesktopTabId(state: AppState, worktreeId: string): string | null {
  const tab = (state.browserTabsByWorktree[worktreeId] ?? []).find((candidate) =>
    isCloudRemoteDesktopTabUrl(candidate.url)
  )
  return tab?.id ?? null
}

/**
 * "Open remote desktop": goes to the workspace's desktop tab, or opens one at once. The tab starts
 * the desktop itself and shows how that goes (starting, asleep, failed with a retry), so a second
 * click lands on the same tab.
 */
export function openCloudRemoteDesktop(worktreeId: string): void {
  if (typeof window.api?.ephemeralVm?.openCloudRemoteDesktop !== 'function') {
    return
  }
  activateAndRevealWorkspace(worktreeId, { providesInitialSurface: true })
  const state = useAppStore.getState()
  const existing = selectRemoteDesktopTabId(state, worktreeId)
  if (existing) {
    state.setActiveBrowserTab(existing, worktreeId)
    return
  }
  // Client-local: the forwarded port lives on this computer, not on the workspace's host.
  state.createBrowserTab(worktreeId, CLOUD_REMOTE_DESKTOP_PENDING_URL, {
    title: translate('components.cloudRemoteDesktop.tabTitle', 'Remote desktop'),
    activate: true,
    browserRuntimeEnvironmentId: null
  })
}
