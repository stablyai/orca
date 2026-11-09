import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store/index'
import { activateAndRevealWorkspace } from '@/lib/workspace/activation/worktree-activation'
import { selectWorkspaceRuntimeEnvironmentId } from '@/lib/workspace/ownership/workspace-runtime-environment'
import type {
  CloudRemoteDesktopFailureCode,
  CloudRemoteDesktopResult
} from '../../../../shared/hosted-sandbox/cloud-remote-desktop'

const SLOW_START_MS = 5_000
const opening = new Set<string>()

function failureDescription(code: CloudRemoteDesktopFailureCode): string {
  switch (code) {
    case 'not_cloud':
      return translate(
        'components.cloudRemoteDesktop.notCloud',
        'Remote Desktop is only available for Orca Cloud workspaces.'
      )
    case 'not_running':
      return translate(
        'components.cloudRemoteDesktop.notRunning',
        'This workspace isn’t running. Open it to start it, then try again.'
      )
    case 'not_installed':
      return translate(
        'components.cloudRemoteDesktop.notInstalled',
        'This workspace was created before Remote Desktop existed. Create a new Orca Cloud workspace to use it.'
      )
    case 'signed_out':
      return translate(
        'components.cloudRemoteDesktop.signedOut',
        'Your Orca Cloud session expired. Sign in again to continue.'
      )
    case 'forward_failed':
      return translate(
        'components.cloudRemoteDesktop.forwardFailed',
        'The desktop started, but Orca couldn’t connect this computer to it.'
      )
    case 'unavailable':
      return translate(
        'components.cloudRemoteDesktop.unavailable',
        'Orca Cloud didn’t start the desktop.'
      )
  }
}

const RETRYABLE: ReadonlySet<CloudRemoteDesktopFailureCode> = new Set([
  'forward_failed',
  'unavailable'
])

/** Desktop identity without the per-boot password or the local port a re-dialed forward may change. */
function desktopPage(url: string): string | null {
  try {
    const parsed = new URL(url)
    return parsed.hostname === 'localhost'
      ? `${parsed.pathname}?${parsed.searchParams.toString()}`
      : null
  } catch {
    return null
  }
}

/**
 * This workspace's desktop tab: reused when it is the current session, replaced when it holds a
 * previous boot's password (it would only retry a dead login), so there is never a second tab.
 */
function takeDesktopTab(worktreeId: string, url: string): string | null {
  const state = useAppStore.getState()
  const base = desktopPage(url)
  let current: string | null = null
  for (const tab of state.browserTabsByWorktree[worktreeId] ?? []) {
    if (desktopPage(tab.url) !== base) {
      continue
    }
    if (tab.url === url && !tab.loadError && current === null) {
      current = tab.id
    } else {
      state.closeBrowserTab(tab.id, { preserveWorktreeSelection: true })
    }
  }
  return current
}

/** Starts the VM's desktop, forwards it here and opens it in an Orca browser tab of the workspace. */
export async function openCloudRemoteDesktop(
  worktreeId: string,
  environmentId: string
): Promise<void> {
  const open = window.api.ephemeralVm.openCloudRemoteDesktop
  if (typeof open !== 'function' || opening.has(environmentId)) {
    return
  }
  opening.add(environmentId)
  const pending = toast.loading(
    translate('components.cloudRemoteDesktop.starting', 'Starting Remote Desktop…')
  )
  const slow = setTimeout(() => {
    toast.loading(translate('components.cloudRemoteDesktop.stillStarting', 'Still starting…'), {
      id: pending
    })
  }, SLOW_START_MS)
  try {
    const result: CloudRemoteDesktopResult = await open({ environmentId })
      .then((value) => value ?? { ok: false as const, code: 'unavailable' as const })
      .catch(() => ({ ok: false as const, code: 'unavailable' as const }))
    clearTimeout(slow)
    if (!result.ok) {
      toast.error(
        translate('components.cloudRemoteDesktop.failedTitle', 'Couldn’t open Remote Desktop'),
        {
          id: pending,
          description: failureDescription(result.code),
          ...(result.code === 'not_running'
            ? {
                action: {
                  label: translate('components.cloudRemoteDesktop.openWorkspace', 'Open Workspace'),
                  onClick: () =>
                    activateAndRevealWorkspace(worktreeId, { providesInitialSurface: true })
                }
              }
            : RETRYABLE.has(result.code)
              ? {
                  action: {
                    label: translate('components.cloudRemoteDesktop.retry', 'Try Again'),
                    onClick: () => void openCloudRemoteDesktop(worktreeId, environmentId)
                  }
                }
              : {})
        }
      )
      return
    }
    toast.dismiss(pending)
    const state = useAppStore.getState()
    // The workspace may have been deleted or moved while the VM answered.
    if (selectWorkspaceRuntimeEnvironmentId(state, worktreeId) !== environmentId) {
      return
    }
    activateAndRevealWorkspace(worktreeId, { providesInitialSurface: true })
    const existing = takeDesktopTab(worktreeId, result.url)
    if (existing) {
      state.setActiveBrowserTab(existing, worktreeId)
      return
    }
    // Client-local: the forwarded port lives on this computer, not on the workspace's host.
    state.createBrowserTab(worktreeId, result.url, {
      title: translate('components.cloudRemoteDesktop.tabTitle', 'Remote Desktop'),
      activate: true,
      browserRuntimeEnvironmentId: null
    })
  } finally {
    clearTimeout(slow)
    opening.delete(environmentId)
  }
}
