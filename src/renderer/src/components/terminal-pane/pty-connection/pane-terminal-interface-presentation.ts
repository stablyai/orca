import {
  readTerminalInterface,
  registerTerminalInterfacePresentation,
  subscribeTerminalInterfacePresentation,
  terminalInterfaceReleasesChat
} from '../../native-chat/terminal-interface-presentation'
import { pendingSpawnByPaneKey } from './pty-connect-limits'
import { isPaneResumingInPlace, isPaneSpawnDeferred } from '@/lib/pane-spawn-deferral-registry'
import { CONFIRMED_SHELL_MODE_RESET } from '../../../../../shared/terminal-mode-reset-profiles'
import { useAppStore } from '@/store'
import { isTuiAgent } from '../../../../../shared/tui-agent-config'
import { isRemoteExecutionHostPtyId } from '../../../../../shared/remote-execution-host-pty-id'
import type { ConnectPanePtySession } from './connect-pane-pty-session'

export function installPaneTerminalInterfacePresentation(session: ConnectPanePtySession): void {
  const pending = (): boolean => {
    const ptyId = session.transport.getPtyId()
    return Boolean(
      session.disposed ||
      session.pendingStartupCommand ||
      session.startupInjectTimer !== null ||
      session.transportConnectInFlightSince !== null ||
      session.pendingSpawnDeferral ||
      session.hibernatedWakeTarget ||
      pendingSpawnByPaneKey.has(session.pendingSpawnKey) ||
      isPaneSpawnDeferred(session.cacheKey) ||
      isPaneResumingInPlace(session.cacheKey) ||
      session.restartReplacementPtyId === ptyId ||
      (ptyId !== null && session.deps.isPtyShutdownPending(ptyId))
    )
  }
  const releasePresentation = registerTerminalInterfacePresentation(session.cacheKey, {
    ptyId: () => session.transport.getPtyId(),
    incarnation: () => session.remotePtyIncarnationId ?? null,
    pending,
    cold: () => {
      const state = useAppStore.getState()
      const ptyId = session.transport.getPtyId()
      const row = state.agentStatusByPaneKey[session.cacheKey]
      return Boolean(
        ptyId &&
        session.spawnedFreshPtyId !== ptyId &&
        !isRemoteExecutionHostPtyId(ptyId) &&
        row &&
        isTuiAgent(row.agentType) &&
        !row.structuredHostOwned &&
        (!row.observation || row.observation.origin === 'hook') &&
        !state.agentLaunchConfigByPaneKey[session.cacheKey] &&
        !session.paneStartup?.launchConfig &&
        !session.paneExpectsLaunchAgent(state) &&
        !session.paneStartup?.command &&
        !pending() &&
        !session.paneForegroundAgentTracker?.hasReadInFlight() &&
        !state.pendingStartupByTabId?.[session.deps.tabId] &&
        !state.automaticAgentResumeClaimsByTabId?.[session.deps.tabId]
      )
    }
  })
  let appliedBinding: string | null = null
  const releaseEffects = subscribeTerminalInterfacePresentation(() => {
    const state = useAppStore.getState()
    const observation = readTerminalInterface(state, session.cacheKey)?.observation
    const binding =
      !session.disposed && observation && terminalInterfaceReleasesChat(state, session.cacheKey)
        ? JSON.stringify([
            observation.epoch,
            observation.ptyId,
            observation.incarnationId,
            observation.terminalHandle
          ])
        : null
    if (binding === appliedBinding) {
      return
    }
    // Title writes reenter this subscription; mark the current applicability first.
    appliedBinding = binding
    if (binding !== null) {
      session.clearStaleAgentTabTitleOnConfirmedShell()
      session.writeInputModeGround(CONFIRMED_SHELL_MODE_RESET)
    }
  })
  session.unregisterTerminalInterfacePresentation = () => {
    releaseEffects()
    releasePresentation()
  }
}
