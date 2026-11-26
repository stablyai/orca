import { useAppStore } from '@/store'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import { runtimeEnvironmentCapabilityProof } from '@/runtime/rpc/compatibility/runtime-capability-proof'
import { getRemoteRuntimePtyOwner } from '@/runtime/hosted-terminals/identity/remote-runtime-pty-owner'
import { readRuntimeStatuses } from '@/store/slices/runtime-status/views/runtime-status-owner'
import {
  resolveAgentResumeLaunchTarget,
  resolveRuntimeHostReportedPlatform,
  resolveRuntimeHostTerminalWindowsShell,
  resolveSshHostReportedPlatform
} from '@/lib/agent-session/resume/agent-resume-launch-target'
import { isRemoteRuntimePtyId } from '../../../../../../shared/remote-runtime/remote-runtime-pty-id'
import { QUEUED_AGENT_LAUNCH_CAPABILITY } from '../../../../../../shared/terminal/runtime-policy/terminal-runtime-capabilities'
import {
  mayResolveQueuedAgentLaunch,
  type PreparedAgentLaunch,
  type QueuedAgentLaunch
} from '../../../../../../shared/agent-launch/startup/queued-agent-launch'
import { prepareShellNativeAgentLaunch } from '../../../../../../shared/agent-launch/startup/codex-startup-image-command'
import { resolveStartupShell } from '../../../../../../shared/agent-launch/startup/tui-agent-startup-shell'
import {
  parseExecutionHostId,
  toRuntimeExecutionHostId
} from '../../../../../../shared/execution-host/execution-host'
import type { ConnectPanePtySession } from '../connect-pane-pty-session'
import type { PendingStartupCommand } from './fresh-spawn-types'

export async function prepareQueuedStartupCommand(
  session: ConnectPanePtySession,
  ptyId: string,
  startup: PendingStartupCommand,
  isCurrent: () => boolean
): Promise<PreparedAgentLaunch> {
  const state = useAppStore.getState()
  const paired = getRemoteRuntimePtyOwner(ptyId)
  const localSession = session.transport.getLocalSessionMetadata?.()
  const reportedHost = session.transport.getExecutionHostId?.() ?? session.executionHostId
  const ssh = parseExecutionHostId(reportedHost)
  const executionHostId =
    paired && ssh?.kind !== 'ssh'
      ? toRuntimeExecutionHostId(paired.target.environmentId)
      : reportedHost
  const connectionId =
    ssh?.kind === 'ssh'
      ? ssh.targetId
      : (session.transport.getConnectionId?.() ?? session.worktreeConnectionId)
  const shellOverride = paired ? undefined : (localSession?.shellOverride ?? session.shellOverride)
  const statuses = readRuntimeStatuses()
  const target = resolveAgentResumeLaunchTarget({
    projectRuntime: session.projectRuntime,
    connectionId,
    executionHostId,
    worktreePath: localSession?.cwd ?? session.worktree?.path,
    terminalWindowsShell: state.settings?.terminalWindowsShell,
    tabShellOverride: shellOverride,
    remotePlatform:
      session.transport.getRemotePlatform?.() ??
      resolveSshHostReportedPlatform(
        state,
        executionHostId,
        paired?.target.environmentId ?? null,
        connectionId
      ),
    runtimeHostPlatform: resolveRuntimeHostReportedPlatform(statuses, executionHostId),
    runtimeHostTerminalWindowsShell: resolveRuntimeHostTerminalWindowsShell(
      statuses,
      executionHostId
    )
  })
  const shell = resolveStartupShell(target.platform, target.shell)
  const images = state.settings?.terminalInlineImages !== false
  const launch: QueuedAgentLaunch = {
    terminal: paired?.terminal ?? ptyId,
    command: startup.command,
    shell,
    shellOverride,
    cwd: localSession?.cwd ?? session.deps.cwd,
    images,
    launchConfig: startup.launchConfig,
    launchAgent: startup.launchAgent,
    restoring: startup.restoring,
    nativeChatSignIn: startup.nativeChatSignIn
  }
  if (mayResolveQueuedAgentLaunch(launch)) {
    try {
      const reply = await requestQueuedLaunch(ptyId, paired, launch, isCurrent)
      if (reply && typeof reply === 'object' && 'preparedCommand' in reply) {
        const prepared = reply as PreparedAgentLaunch
        return typeof prepared.preparedCommand === 'string' ? prepared : { preparedCommand: null }
      }
    } catch {
      // Delivery can be retried once the pane has a current host again.
    }
    return { preparedCommand: null }
  }
  return {
    preparedCommand:
      startup.launchConfig?.commandProvenance === 'authored'
        ? startup.command
        : prepareShellNativeAgentLaunch(startup.command, shell, images)
  }
}

async function requestQueuedLaunch(
  ptyId: string,
  paired: ReturnType<typeof getRemoteRuntimePtyOwner>,
  launch: QueuedAgentLaunch,
  isCurrent: () => boolean
): Promise<unknown> {
  if (!paired) {
    return !isRemoteRuntimePtyId(ptyId) && isCurrent()
      ? window.api.preflight.detectAgents({ launch })
      : undefined
  }
  const proof = await runtimeEnvironmentCapabilityProof(
    paired.target.environmentId,
    QUEUED_AGENT_LAUNCH_CAPABILITY
  )
  if (!proof.supported || !isCurrent()) {
    return undefined
  }
  return callRuntimeRpc<unknown>(
    paired.target,
    'preflight.detectAgents',
    { launch },
    {
      expectedEnvironmentRuntimeId: proof.runtimeId,
      expectedEnvironmentPairingRevision: proof.pairingRevision,
      skipCompatibilityCheck: true
    }
  )
}
