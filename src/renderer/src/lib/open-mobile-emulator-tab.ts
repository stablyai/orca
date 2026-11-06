import { toast } from 'sonner'
import type { EmulatorStreamInfo } from '@/components/emulator-pane/emulator-pane-types'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { emulatorErrorText } from './emulator-error-copy'
import { ensureSimulatorTab, getSimulatorTabForWorktree } from './ensure-simulator-tab'
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
import { assertClientCreationActionAvailable } from './client-creation-action-policy'
import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'

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
  return emulatorErrorText(
    error,
    translate(
      'auto.lib.open.mobile.emulator.tab.bf4f2a8a72',
      'Could not start the emulator. Check iOS or Android emulator setup and try another device.'
    )
  )
}

export async function openMobileEmulatorTab(
  worktreeId: string,
  options: OpenMobileEmulatorTabOptions = {}
): Promise<string | null> {
  const store = useAppStore.getState()
  assertClientCreationActionAvailable(store, worktreeId, 'mobile-emulator')
  if (store.settings?.mobileEmulatorEnabled === false) {
    return null
  }
  const existingTab = getSimulatorTabForWorktree(worktreeId, LOCAL_EXECUTION_HOST_ID)
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
  if (alreadyLaunching) {
    return ensureSimulatorTab(worktreeId, {
      placement: options.placement ?? 'rightSplit',
      targetGroupId,
      surfacePane: true,
      executionHostId: LOCAL_EXECUTION_HOST_ID
    })
  }
  beginManualSimulatorLaunch(worktreeId)
  try {
    // Own the guard through create/attach; release on every error/early return so retries remain possible.
    const tabId = ensureSimulatorTab(worktreeId, {
      placement: options.placement ?? 'rightSplit',
      targetGroupId,
      surfacePane: true,
      executionHostId: LOCAL_EXECUTION_HOST_ID
    })
    if (!tabId) {
      return null
    }
    dispatchManualSimulatorLaunchStarted(worktreeId)
    try {
      // Keep the pane inert during serve-sim startup; expose its stream only after attach confirms readiness.
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
      // If users close during startup, clean the managed session once attach registers it.
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
    }
  } finally {
    finishManualSimulatorLaunch(worktreeId)
  }
}
