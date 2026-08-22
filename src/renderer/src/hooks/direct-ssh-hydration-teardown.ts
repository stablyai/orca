import type { RemoteWorkspaceTargetSync } from './remote-workspace-target-sync'
import type { BackgroundSleepingAgentWakeDispatcher } from '../lib/wake-sleeping-agents-in-background'

export function stopDirectSshHydrationLifecycle(
  wakeDispatcher: Pick<BackgroundSleepingAgentWakeDispatcher, 'dispose'>,
  targetSync: Pick<RemoteWorkspaceTargetSync, 'stop'> | null
): void {
  wakeDispatcher.dispose()
  targetSync?.stop()
}
