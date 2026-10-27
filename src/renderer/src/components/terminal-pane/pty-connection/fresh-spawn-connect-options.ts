import { useAppStore } from '@/store'
import type { ColdRestoreAgentResumeStartup, PendingStartupCommand } from './fresh-spawn-types'
import type { ConnectPanePtySession } from './connect-pane-pty-session'
import { findTerminalTabForPane } from './terminal-tab-id'
import type { PtyConnectResult, PtyTransport } from '../pty-transport-types'

export function freshSpawnPtyId(result: void | string | PtyConnectResult): string | null {
  return typeof result === 'string' ? result : (result?.id ?? null)
}

type FreshSpawnConnectOptions = Parameters<PtyTransport['connect']>[0]
type FreshSpawnCallbacks = FreshSpawnConnectOptions['callbacks']

/** The transport request for one fresh spawn, including the generation fence. */
export function freshSpawnTransportConnectOptions(args: {
  session: ConnectPanePtySession
  startupOverride: PendingStartupCommand | null | undefined
  coldRestoreOverride: ColdRestoreAgentResumeStartup | null
  visibleAtSpawn: boolean
  callbacks: FreshSpawnCallbacks
}): FreshSpawnConnectOptions {
  const { session, startupOverride, coldRestoreOverride, visibleAtSpawn, callbacks } = args
  return {
    url: '',
    cols: session.cols,
    rows: session.rows,
    ...(startupOverride?.command ? { command: startupOverride.command } : {}),
    ...(startupOverride?.env
      ? { env: session.mergeStartupEnvWithPaneIdentity(startupOverride.env) }
      : {}),
    ...(coldRestoreOverride ? { launchConfig: coldRestoreOverride.launchConfig } : {}),
    ...(coldRestoreOverride
      ? {
          resumeProviderSession: coldRestoreOverride.resumeProviderSession,
          resumeOrigin: coldRestoreOverride.resumeOrigin
        }
      : {}),
    ...(coldRestoreOverride ? { launchToken: coldRestoreOverride.launchToken } : {}),
    ...(coldRestoreOverride ? { launchAgent: coldRestoreOverride.agent } : {}),
    ...(session.shouldDeclareHiddenAtSpawn() ? { initiallyHidden: true } : {}),
    resumeSpawnIntent: visibleAtSpawn ? 'user-resume' : 'automatic-restore',
    ...(session.pendingReplacedPtyId
      ? { claimReplacedPtyId: session.claimPendingReplacedPtyId }
      : {}),
    shouldContinue: () =>
      !session.disposed &&
      (findTerminalTabForPane(useAppStore.getState(), session.deps.worktreeId, session.deps.tabId)
        ?.generation ?? 0) === session.tabGeneration,
    callbacks
  }
}
