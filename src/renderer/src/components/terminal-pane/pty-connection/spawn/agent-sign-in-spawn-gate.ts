import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store/index'
import { agentLaunchPanePrompt } from '@/lib/agent-session/launch/pane/agent-launch-pane-prompt'
import { requireAgentSignIn } from '@/lib/agent-sign-in/agent-sign-in-gate'
import type { PendingStartupCommand } from '../startup/fresh-spawn-types'
import type { ConnectPanePtySession } from '../connect-pane-pty-session'
import { pendingSpawnByPaneKey, pendingSpawnGenerationByPaneKey } from './pending-pane-spawn'

type GateRequest = Parameters<typeof requireAgentSignIn>[0]

/** A fresh Claude/Codex launch on a runtime host; resumes and plain shells are never held. */
export function agentSignInGateRequest(
  session: ConnectPanePtySession,
  startupOverride: PendingStartupCommand | null | undefined
): GateRequest | null {
  const environmentId = session.runtimeEnvironmentId
  const startup = session.paneStartup
  if (startupOverride !== undefined || !environmentId || !startup) {
    return null
  }
  // Fresh launches also carry launchConfig (for a later resume); only resume facts mark a resume.
  if (startup.resumeSource || startup.resumeProviderSession) {
    return null
  }
  const agent = startup.launchAgent ?? startup.agentLaunch?.launch.agent
  if (agent !== 'claude' && agent !== 'codex') {
    return null
  }
  const prompt =
    startup.freshAgentLaunch?.prompt ??
    startup.agentLaunch?.launch.prompt ??
    startup.draftPrompt ??
    startup.initialAgentStatus?.prompt ??
    agentLaunchPanePrompt(session.deps.tabId)
  const hostLabel =
    useAppStore
      .getState()
      .runtimeEnvironments?.find((environment) => environment.id === environmentId)?.name ??
    environmentId
  return {
    key: session.cacheKey,
    environmentId,
    hostLabel,
    agent,
    prompt: prompt?.trim() || null
  }
}

function noteCancelledLaunch(prompt: string | null): void {
  toast(
    translate('agentSignIn.cancelledToast', 'Sign-in cancelled. The agent did not start.'),
    prompt
      ? {
          action: {
            label: translate('agentSignIn.copyPrompt', 'Copy prompt'),
            onClick: () => void window.api.ui.writeClipboardText(prompt)
          }
        }
      : undefined
  )
}

/**
 * Holds the pane's first spawn until its agent is signed in on the host. The held spawn is
 * registered as pending so a remount waits for it instead of starting a second agent.
 */
export function gateFreshSpawnOnAgentSignIn(
  session: ConnectPanePtySession,
  request: GateRequest,
  spawn: (startupOverride?: null) => Promise<string | null>
): Promise<string | null> {
  const held = requireAgentSignIn(request).then((outcome) => {
    if (session.disposed) {
      return null
    }
    if (outcome === 'cancel') {
      // Only this pane's agent is dropped; the pane opens a plain shell like a new terminal.
      noteCancelledLaunch(request.prompt)
      return spawn(null)
    }
    return spawn()
  })
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

/** A first Claude/Codex launch on a signed-out host waits for its inline sign-in. */
export function installAgentSignInSpawnGate(session: ConnectPanePtySession): void {
  const start = session.startFreshSpawn
  session.startFreshSpawn = (startupOverride, options) => {
    const request = agentSignInGateRequest(session, startupOverride)
    return request
      ? gateFreshSpawnOnAgentSignIn(session, request, (override = startupOverride) =>
          start(override, options)
        )
      : start(startupOverride, options)
  }
}
