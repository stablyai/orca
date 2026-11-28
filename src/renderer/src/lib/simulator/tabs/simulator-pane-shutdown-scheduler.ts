import { EMULATOR_SHUTDOWN_ACTIVE_DEVICE_CAPABILITY } from '../../../../../shared/remote-runtime/protocol/emulator-runtime-capabilities'
import { emulatorRuntimeTarget } from '@/lib/simulator/runtime/emulator-runtime-target'
import {
  acceptedEmulatorStreamSession,
  emulatorSessionStartedHere,
  noteEmulatorSessionStopped,
  releaseEmulatorStream
} from '@/lib/simulator/runtime/emulator-runtime-attach'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import { runtimeEnvironmentSupportsCapability } from '@/runtime/rpc/compatibility/runtime-capability-proof'
import { useAppStore } from '@/store/index'
import { shouldShutdownSimulatorForPaneUnmountFromTabs } from './simulator-tab-shutdown'

type SimulatorTabReference = {
  id: string
  contentType: string
}

type SimulatorPaneShutdownOptions = {
  getTabsForWorktree?: (worktreeId: string) => SimulatorTabReference[]
  shutdownManagedSimulator?: (worktreeId: string) => unknown
}

type ScheduleSimulatorPaneShutdownOptions = SimulatorPaneShutdownOptions & {
  delayMs?: number
}

const DEFAULT_SHUTDOWN_GRACE_MS = 1_500

const pendingShutdownTimersByWorktree = new Map<string, ReturnType<typeof setTimeout>>()

function getUnifiedTabsForWorktree(worktreeId: string): SimulatorTabReference[] {
  return useAppStore.getState().unifiedTabsByWorktree[worktreeId] ?? []
}

async function shutdownManagedSimulator(worktreeId: string): Promise<void> {
  const target = emulatorRuntimeTarget(worktreeId)
  const session = acceptedEmulatorStreamSession(worktreeId)
  const started = emulatorSessionStartedHere(worktreeId)
  try {
    // On a server only the session this desktop started is its to stop; an agent's may run there too.
    if (target.kind === 'environment' && !started) {
      return
    }
    // A server that ignores activeDevice would stop whichever session another client switched to.
    if (
      target.kind === 'environment' &&
      !(await runtimeEnvironmentSupportsCapability(
        target.environmentId,
        EMULATOR_SHUTDOWN_ACTIVE_DEVICE_CAPABILITY
      ).catch(() => false))
    ) {
      return
    }
    await callRuntimeRpc(target, 'emulator.shutdown', {
      worktree: worktreeId,
      managedOnly: true,
      ...(started?.device ? { activeDevice: started.device } : {})
    })
    if (started) {
      noteEmulatorSessionStopped(worktreeId, started.generation)
    }
  } finally {
    if (session) {
      releaseEmulatorStream(worktreeId, session)
    }
  }
}

export async function shutdownManagedSimulatorIfNoPane(
  worktreeId: string,
  tabId?: string,
  options: SimulatorPaneShutdownOptions = {}
): Promise<boolean> {
  const getTabsForWorktree = options.getTabsForWorktree ?? getUnifiedTabsForWorktree
  if (!shouldShutdownSimulatorForPaneUnmountFromTabs(getTabsForWorktree(worktreeId), tabId)) {
    return false
  }
  const shutdown = options.shutdownManagedSimulator ?? shutdownManagedSimulator
  await Promise.resolve(shutdown(worktreeId)).catch(() => {})
  return true
}

export function cancelPendingSimulatorPaneShutdown(worktreeId: string): void {
  const timer = pendingShutdownTimersByWorktree.get(worktreeId)
  if (!timer) {
    return
  }
  clearTimeout(timer)
  pendingShutdownTimersByWorktree.delete(worktreeId)
}

export function scheduleSimulatorPaneManagedShutdown(
  worktreeId: string,
  tabId?: string,
  options: ScheduleSimulatorPaneShutdownOptions = {}
): boolean {
  const getTabsForWorktree = options.getTabsForWorktree ?? getUnifiedTabsForWorktree
  if (!shouldShutdownSimulatorForPaneUnmountFromTabs(getTabsForWorktree(worktreeId), tabId)) {
    return false
  }

  cancelPendingSimulatorPaneShutdown(worktreeId)
  const delayMs = options.delayMs ?? DEFAULT_SHUTDOWN_GRACE_MS
  const shutdown = options.shutdownManagedSimulator ?? shutdownManagedSimulator
  const timer = setTimeout(() => {
    pendingShutdownTimersByWorktree.delete(worktreeId)
    if (!shouldShutdownSimulatorForPaneUnmountFromTabs(getTabsForWorktree(worktreeId))) {
      return
    }
    // Delay shutdown across brief close/reopen/move unmounts so replacement panes can reuse the stream.
    void shutdownManagedSimulatorIfNoPane(worktreeId, undefined, {
      getTabsForWorktree,
      shutdownManagedSimulator: shutdown
    })
  }, delayMs)
  pendingShutdownTimersByWorktree.set(worktreeId, timer)
  return true
}
