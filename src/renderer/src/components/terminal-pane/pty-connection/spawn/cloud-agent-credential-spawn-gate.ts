// Private layer, Orca Cloud only: a fresh Claude/Codex launch whose Orca-account sign-in expired
// (and no key covers it) waits on the account-recovery strip before #40228's per-host gate runs.
// Installed outside that gate, so it wraps it; it reads #40228's exports and changes none of them.
// An agent the person signs in inside each workspace skips both: it starts as it is, and its own
// sign-in shows in the pane (the vendor's flow, its token kept in the workspace).
import { useAppStore } from '@/store/index'
import {
  cloudAgentLaunchNeedsHold,
  cloudAgentSignsInInsideWorkspace,
  holdCloudAgentLaunch
} from '@/lib/orca-cloud/cloud-agent-launch-hold'
import { isOrcaCloudEnvironmentForLaunch } from '@/lib/orca-cloud/orca-cloud-environment-id'
import { isOrcaCloudRuntimeEnvironment } from '../../../../../../shared/remote-runtime/host-catalog/orca-cloud-environment-name'
import type { ConnectPanePtySession } from '../connect-pane-pty-session'
import { agentSignInGateRequest } from './agent-sign-in-spawn-gate'
import { pendingSpawnByPaneKey, pendingSpawnGenerationByPaneKey } from './pending-pane-spawn'

function isOrcaCloudEnvironment(environmentId: string): boolean {
  const environment = useAppStore
    .getState()
    .runtimeEnvironments?.find((entry) => entry.id === environmentId)
  return environment ? isOrcaCloudRuntimeEnvironment(environment) : false
}

export function installCloudAgentCredentialGate(session: ConnectPanePtySession): void {
  const start = session.startFreshSpawn
  const ungated: typeof start = session.startFreshSpawnWithoutSignInGate ?? start
  session.startFreshSpawn = (startupOverride, options) => {
    const request = agentSignInGateRequest(session, startupOverride)
    // Ready (or covered by a key): no hold, no delay; the launch starts as it always did.
    if (
      !request ||
      (cloudAgentLaunchNeedsHold(request.agent) === false &&
        !cloudAgentSignsInInsideWorkspace(request.agent))
    ) {
      return start(startupOverride, options)
    }
    // Read when the launch goes ahead: the choice may have been made on the strip that held it.
    const launch = (override: typeof startupOverride) =>
      cloudAgentSignsInInsideWorkspace(request.agent)
        ? ungated(override, options)
        : start(override, options)
    // Fail closed: the catalog flag can lag a fresh pairing, so without it main is asked
    // before the agent may start; until it answers, nothing is spawned.
    const cloud = isOrcaCloudEnvironment(request.environmentId)
      ? Promise.resolve(true)
      : isOrcaCloudEnvironmentForLaunch(request.environmentId)
    const held = cloud.then((isCloud) => {
      if (session.disposed) {
        return null
      }
      if (!isCloud) {
        return start(startupOverride, options)
      }
      if (cloudAgentSignsInInsideWorkspace(request.agent)) {
        return launch(startupOverride)
      }
      return holdCloudAgentLaunch({
        paneKey: request.key,
        agent: request.agent,
        prompt: request.prompt
      }).then((outcome) => {
        if (session.disposed) {
          return null
        }
        // Cancel opens a plain shell, like cancelling the per-host sign-in.
        return outcome === 'cancel' ? start(null, options) : launch(startupOverride)
      })
    })
    // A remount while held waits for this launch instead of starting a second agent.
    const tracked = held.finally(() => {
      if (pendingSpawnByPaneKey.get(session.pendingSpawnKey) === tracked) {
        pendingSpawnByPaneKey.delete(session.pendingSpawnKey)
        pendingSpawnGenerationByPaneKey.delete(session.pendingSpawnKey)
      }
    })
    pendingSpawnByPaneKey.set(session.pendingSpawnKey, tracked)
    pendingSpawnGenerationByPaneKey.set(session.pendingSpawnKey, session.tabGeneration)
    return tracked
  }
}
