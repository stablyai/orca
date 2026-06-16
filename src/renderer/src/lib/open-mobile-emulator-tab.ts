import { toast } from 'sonner'
import type { EmulatorStreamInfo } from '@/components/emulator-pane/emulator-pane-types'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { useAppStore } from '@/store'
import { ensureSimulatorTab, getSimulatorTabForWorktree, isMacOsHost } from './ensure-simulator-tab'
import {
  beginManualSimulatorLaunch,
  dispatchManualSimulatorLaunchFailed,
  dispatchManualSimulatorLaunchStarted,
  finishManualSimulatorLaunch,
  isManualSimulatorLaunchPending,
  rememberPrelaunchedSimulatorSession
} from './simulator-launch-coordination'
import {
  cancelPendingSimulatorPaneShutdown,
  shutdownManagedSimulatorIfNoPane
} from './simulator-pane-shutdown-scheduler'

type OpenMobileEmulatorTabOptions = {
  targetGroupId?: string
  placement?: 'activeGroup' | 'rightSplit'
}

type EmulatorAttachResult = {
  attached?: boolean
  info?: EmulatorStreamInfo
}

function dispatchPrelaunchedSession(worktreeId: string, info: EmulatorStreamInfo): void {
  if (typeof window === 'undefined') {
    return
  }
  window.setTimeout(() => {
    window.dispatchEvent(
      new CustomEvent('orca:emulator-auto-attach', {
        detail: { worktreeId, info }
      })
    )
  }, 0)
}

function getLaunchErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message
  }
  return 'Could not start the emulator. Check that Xcode is installed and try another device.'
}

export async function openMobileEmulatorTab(
  worktreeId: string,
  options: OpenMobileEmulatorTabOptions = {}
): Promise<string | null> {
  if (!isMacOsHost) {
    return null
  }
  const store = useAppStore.getState()
  if (store.settings?.mobileEmulatorEnabled === false) {
    return null
  }
  const existingTab = getSimulatorTabForWorktree(worktreeId)
  if (existingTab) {
    return existingTab.id
  }
  const targetGroupId =
    options.targetGroupId ??
    store.activeGroupIdByWorktree[worktreeId] ??
    store.groupsByWorktree[worktreeId]?.[0]?.id
  if (!targetGroupId) {
    return null
  }

  cancelPendingSimulatorPaneShutdown(worktreeId)
  const alreadyLaunching = isManualSimulatorLaunchPending(worktreeId)
  if (!alreadyLaunching) {
    beginManualSimulatorLaunch(worktreeId)
  }
  const tabId = ensureSimulatorTab(worktreeId, {
    placement: options.placement ?? 'rightSplit',
    targetGroupId,
    surfacePane: true
  })
  if (!tabId || alreadyLaunching) {
    return tabId
  }
  dispatchManualSimulatorLaunchStarted(worktreeId)
  try {
    // Why: the pane is visible but inert while serve-sim settles; the actual
    // stream is handed to it only after attach returns ready info.
    const result = await callRuntimeRpc<EmulatorAttachResult>(
      { kind: 'local' },
      'emulator.attach',
      {
        worktree: worktreeId,
        focus: false
      }
    )
    if (!result.attached || !result.info) {
      throw new Error('Could not start the emulator.')
    }
    // Why: users can close the tab while serve-sim is still starting; after
    // attach registers the managed session, clean it up if no pane remains.
    if (await shutdownManagedSimulatorIfNoPane(worktreeId, tabId)) {
      return tabId
    }

    rememberPrelaunchedSimulatorSession(worktreeId, result.info)
    dispatchPrelaunchedSession(worktreeId, result.info)
    return tabId
  } catch (error) {
    const message = getLaunchErrorMessage(error)
    toast.error(message)
    dispatchManualSimulatorLaunchFailed(worktreeId, message)
    return tabId
  } finally {
    finishManualSimulatorLaunch(worktreeId)
  }
}
