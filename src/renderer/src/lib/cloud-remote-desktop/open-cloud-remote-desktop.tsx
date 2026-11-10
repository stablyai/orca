import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store/index'
import { activateAndRevealWorkspace } from '@/lib/workspace/activation/worktree-activation'
import { selectWorkspaceRuntimeEnvironmentId } from '@/lib/workspace/ownership/workspace-runtime-environment'
import {
  CloudRemoteDesktopToast,
  type CloudRemoteDesktopNextAction,
  type CloudRemoteDesktopToastState
} from '@/components/cloud-remote-desktop/CloudRemoteDesktopToast'
import type { CloudRemoteDesktopResult } from '../../../../shared/hosted-sandbox/cloud-remote-desktop'

const SLOW_START_MS = 5_000
const opening = new Set<string>()

/** Desktop identity without the local port a re-dialed forward may change (or an older URL form). */
function desktopPage(url: string): string | null {
  try {
    const parsed = new URL(url)
    return parsed.hostname === 'localhost' ? parsed.pathname : null
  } catch {
    return null
  }
}

/**
 * This workspace's desktop tab: reused when it is this session's page (main hands it a fresh ticket
 * and resumes it if it stopped retrying), replaced when it points at an older forward or failed to
 * load, so there is never a second tab.
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

/** Starts the sandbox's desktop, forwards it to this computer and opens it in a browser tab. */
export async function openCloudRemoteDesktop(
  worktreeId: string,
  environmentId: string
): Promise<void> {
  const open = window.api.ephemeralVm.openCloudRemoteDesktop
  if (typeof open !== 'function' || opening.has(environmentId)) {
    return
  }
  opening.add(environmentId)
  const id = `cloud-remote-desktop:${environmentId}`
  const show = (state: CloudRemoteDesktopToastState): void => {
    toast.custom(
      () => (
        <CloudRemoteDesktopToast
          state={state}
          onDismiss={() => toast.dismiss(id)}
          onAction={(action) => {
            toast.dismiss(id)
            runNextAction(action, worktreeId, environmentId)
          }}
        />
      ),
      // Errors stay until dismissed or acted on: each names the one next step.
      { id, duration: Number.POSITIVE_INFINITY }
    )
  }
  show({ kind: 'starting', slow: false })
  const slow = setTimeout(() => show({ kind: 'starting', slow: true }), SLOW_START_MS)
  try {
    const result: CloudRemoteDesktopResult = await open({ environmentId })
      .then((value) => value ?? { ok: false as const, code: 'unavailable' as const })
      .catch(() => ({ ok: false as const, code: 'unavailable' as const }))
    clearTimeout(slow)
    if (!result.ok) {
      show({ kind: 'failed', code: result.code })
      return
    }
    toast.dismiss(id)
    const state = useAppStore.getState()
    // The workspace may have been deleted or moved while the sandbox answered.
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
      title: translate('components.cloudRemoteDesktop.tabTitle', 'Remote desktop'),
      activate: true,
      browserRuntimeEnvironmentId: null
    })
  } finally {
    clearTimeout(slow)
    opening.delete(environmentId)
  }
}

function runNextAction(
  action: CloudRemoteDesktopNextAction,
  worktreeId: string,
  environmentId: string
): void {
  switch (action) {
    case 'wake':
      // Opening a sleeping cloud workspace wakes its sandbox.
      activateAndRevealWorkspace(worktreeId, { providesInitialSurface: true })
      return
    case 'sign_in':
      void useAppStore.getState().connectCurrentOrcaProfile()
      return
    case 'create_workspace':
      useAppStore.getState().openModal('new-workspace-composer', { telemetrySource: 'unknown' })
      return
    case 'retry':
      void openCloudRemoteDesktop(worktreeId, environmentId)
  }
}
