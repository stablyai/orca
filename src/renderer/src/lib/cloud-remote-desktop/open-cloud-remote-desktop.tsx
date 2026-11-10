import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store/index'
import { activateAndRevealWorkspace } from '@/lib/workspace/activation/worktree-activation'
import { selectWorkspaceRuntimeEnvironmentId } from '@/lib/workspace/ownership/workspace-runtime-environment'
import { getCloudWorkspaceSnapshot } from '@/lib/orca-cloud/orca-cloud-workspace-store'
import {
  runUnarchiveCloudWorkspace,
  wakeCloudWorkspace
} from '@/components/orca-cloud/cloud-workspace-actions'
import {
  CloudRemoteDesktopToast,
  type CloudRemoteDesktopNextAction,
  type CloudRemoteDesktopToastState
} from '@/components/cloud-remote-desktop/CloudRemoteDesktopToast'
import type { CloudRemoteDesktopResult } from '../../../../shared/hosted-sandbox/cloud-remote-desktop'
import { openDesktopAfterWake } from './open-after-wake'

const SLOW_START_MS = 5_000
/** Worktree ids with an open (or a wake, then open) in flight. */
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

type DesktopToast = {
  show: (state: CloudRemoteDesktopToastState) => void
  /** "Starting…", then "Still starting…" after a few seconds; returns that timer's cancel. */
  showStarting: () => () => void
  dismiss: () => void
}

function desktopToast(worktreeId: string): DesktopToast {
  const id = `cloud-remote-desktop:${worktreeId}`
  const dismiss = (): void => {
    toast.dismiss(id)
  }
  const show = (state: CloudRemoteDesktopToastState): void => {
    toast.custom(
      () => (
        <CloudRemoteDesktopToast
          state={state}
          onDismiss={dismiss}
          onAction={(action) => {
            dismiss()
            runNextAction(action, worktreeId)
          }}
        />
      ),
      // Errors stay until dismissed or acted on: each names the one next step.
      { id, duration: Number.POSITIVE_INFINITY }
    )
  }
  return {
    show,
    dismiss,
    showStarting: () => {
      show({ kind: 'starting', slow: false })
      const slow = setTimeout(() => show({ kind: 'starting', slow: true }), SLOW_START_MS)
      return () => clearTimeout(slow)
    }
  }
}

function requestDesktop(environmentId: string): Promise<CloudRemoteDesktopResult> {
  const open = window.api?.ephemeralVm?.openCloudRemoteDesktop
  if (typeof open !== 'function') {
    return Promise.resolve({ ok: false, code: 'unavailable' })
  }
  return open({ environmentId })
    .then((value) => value ?? { ok: false as const, code: 'unavailable' as const })
    .catch(() => ({ ok: false as const, code: 'unavailable' as const }))
}

/** Opens (or reuses) the workspace's desktop tab, unless the workspace moved meanwhile. */
function showDesktopTab(worktreeId: string, environmentId: string, url: string): void {
  const state = useAppStore.getState()
  // The workspace may have been deleted or moved while the sandbox answered.
  if (selectWorkspaceRuntimeEnvironmentId(state, worktreeId) !== environmentId) {
    return
  }
  activateAndRevealWorkspace(worktreeId, { providesInitialSurface: true })
  const existing = takeDesktopTab(worktreeId, url)
  if (existing) {
    state.setActiveBrowserTab(existing, worktreeId)
    return
  }
  // Client-local: the forwarded port lives on this computer, not on the workspace's host.
  state.createBrowserTab(worktreeId, url, {
    title: translate('components.cloudRemoteDesktop.tabTitle', 'Remote desktop'),
    activate: true,
    browserRuntimeEnvironmentId: null
  })
}

/** One open or wake at a time per workspace: a second click while one runs does nothing. */
async function exclusive(worktreeId: string, work: () => Promise<void>): Promise<void> {
  if (typeof window.api?.ephemeralVm?.openCloudRemoteDesktop !== 'function') {
    return
  }
  if (opening.has(worktreeId)) {
    return
  }
  opening.add(worktreeId)
  try {
    await work()
  } finally {
    opening.delete(worktreeId)
  }
}

/** Starts the sandbox's desktop, forwards it to this computer and opens it in a browser tab. */
export function openCloudRemoteDesktop(worktreeId: string, environmentId: string): Promise<void> {
  return exclusive(worktreeId, async () => {
    const view = desktopToast(worktreeId)
    const stopSlow = view.showStarting()
    const result = await requestDesktop(environmentId).finally(stopSlow)
    if (!result.ok) {
      view.show({ kind: 'failed', code: result.code })
      return
    }
    view.dismiss()
    showDesktopTab(worktreeId, environmentId, result.url)
  })
}

/** Wake (or Unarchive) from the toast, then open the desktop as soon as the sandbox is awake. */
function wakeThenOpen(worktreeId: string, via: 'wake' | 'unarchive'): Promise<void> {
  return exclusive(worktreeId, async () => {
    const view = desktopToast(worktreeId)
    view.show({ kind: 'waking' })
    let stopSlow = (): void => {}
    const outcome = await openDesktopAfterWake({
      wake:
        via === 'unarchive'
          ? () => runUnarchiveCloudWorkspace(worktreeId)
          : () => wakeCloudWorkspace(worktreeId).then(() => true),
      wakeFailedSince: (startedAt) => {
        const wake = getCloudWorkspaceSnapshot().wake[worktreeId]
        return wake?.phase === 'failed' && wake.at >= startedAt
      },
      environmentId: () => selectWorkspaceRuntimeEnvironmentId(useAppStore.getState(), worktreeId),
      open: requestDesktop,
      onAwake: () => {
        stopSlow = view.showStarting()
      }
    }).finally(() => stopSlow())
    if (outcome.kind === 'failed') {
      view.show({ kind: 'failed', code: outcome.code })
      return
    }
    view.dismiss()
    if (outcome.kind === 'opened') {
      showDesktopTab(worktreeId, outcome.environmentId, outcome.url)
    }
  })
}

function runNextAction(action: CloudRemoteDesktopNextAction, worktreeId: string): void {
  switch (action) {
    case 'wake':
    case 'unarchive':
      void wakeThenOpen(worktreeId, action)
      return
    case 'sign_in':
      void useAppStore.getState().connectCurrentOrcaProfile()
      return
    case 'create_workspace':
      useAppStore.getState().openModal('new-workspace-composer', { telemetrySource: 'unknown' })
      return
    case 'retry': {
      // Re-read: a retry after a move or a re-pair must ask the workspace's current sandbox.
      const environmentId = selectWorkspaceRuntimeEnvironmentId(useAppStore.getState(), worktreeId)
      if (environmentId) {
        void openCloudRemoteDesktop(worktreeId, environmentId)
      }
    }
  }
}
