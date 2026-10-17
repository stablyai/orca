import type { TuiAgent } from '../../../shared/tui-agent'
import {
  deliverLaunchPromptToAgentTab,
  seedNativeChatLaunchDraftForAgentTab
} from '../lib/agent-launch-prompt-delivery'
import { createWebRuntimeSessionTerminalResult } from './web-runtime-terminal-create-operation'
import { notifyWebRuntimeTerminalCreateFailure } from './web-runtime-terminal-create-failure-notice'
import { toWebTerminalSurfaceTabId } from '../../../shared/terminal-surface-id'
import type {
  CreateWebRuntimeSessionTerminalArgs,
  WebRuntimeTerminalCreateOutcome
} from './web-runtime-session-types'
import { toRuntimeExecutionHostId } from '../../../shared/execution-host'
import {
  resolveSshHostProxyEnvForTarget,
  sshTargetIdForExecutionHost,
  withSshHostProxyEnv
} from '../lib/ssh-host-proxy-env'
import { useAppStore } from '../store'
import { resolveWebRuntimeSessionEnvironmentId } from './web-runtime-session-workspace-routing'

/**
 * Why: the host spawns these PTYs and cannot read this client's per-host proxy setting, so every
 * host-side create has to carry it down. The target gate stays synchronous so hosts that are not one
 * of this client's SSH hosts keep the exact create sequencing they had before.
 */
async function createHostTerminal(args: CreateWebRuntimeSessionTerminalArgs) {
  const environmentId = resolveWebRuntimeSessionEnvironmentId(
    args.environmentId,
    useAppStore.getState().settings?.activeRuntimeEnvironmentId
  )
  const sshHostTargetId = environmentId
    ? sshTargetIdForExecutionHost(
        toRuntimeExecutionHostId(environmentId),
        useAppStore.getState().runtimeEnvironments
      )
    : null
  if (!sshHostTargetId) {
    return await createWebRuntimeSessionTerminalResult(args)
  }
  const hostProxyEnv = await resolveSshHostProxyEnvForTarget({
    targetId: sshHostTargetId,
    listTargets: () => window.api.ssh.listTargets()
  })
  return await createWebRuntimeSessionTerminalResult({
    ...args,
    env: withSshHostProxyEnv(args.env, hostProxyEnv)
  })
}

/**
 * A host-side failure is toasted here because the host never mirrors a tab for it, so no pane
 * exists to show the error. `notifyFailure: false` is for callers that report it themselves.
 */
export async function createWebRuntimeSessionTerminal(
  args: CreateWebRuntimeSessionTerminalArgs,
  options: { notifyFailure?: boolean } = {}
): Promise<WebRuntimeTerminalCreateOutcome> {
  const created = await createHostTerminal(args)
  if (
    created.hostFailed &&
    created.outcome.status === 'failed' &&
    options.notifyFailure !== false
  ) {
    notifyWebRuntimeTerminalCreateFailure(created.outcome.message, {
      environmentId: args.environmentId ?? null,
      worktreeId: args.worktreeId
    })
  }
  return created.outcome
}

export async function createWebRuntimeAgentSessionTerminal(
  args: CreateWebRuntimeSessionTerminalArgs & {
    agent: TuiAgent
    promptAfterReady: string
    submitPrompt: boolean
    forcePromptPaste: boolean
  }
): Promise<{
  outcome: WebRuntimeTerminalCreateOutcome
  promptDelivered: boolean
}> {
  const created = await createHostTerminal(args)
  if (created.outcome.status === 'failed' || !created.hostTabId) {
    return { outcome: created.outcome, promptDelivered: false }
  }

  const promptDelivered = await deliverLaunchPromptToAgentTab({
    tabId: toWebTerminalSurfaceTabId(created.hostTabId),
    content: args.promptAfterReady,
    agent: args.agent,
    submit: args.submitPrompt,
    forcePaste: args.forcePromptPaste
  })
  return { outcome: created.outcome, promptDelivered }
}

/**
 * Launch a web-host agent terminal whose draft already rode in on the launch
 * command (argv prefill). No post-ready paste runs for that delivery, so seed
 * the chat-composer copy here once the mirrored host tab id is known.
 */
export async function createWebRuntimeAgentSessionTerminalWithLaunchDraft(
  args: CreateWebRuntimeSessionTerminalArgs & {
    agent: TuiAgent
    launchDraft: string
  }
): Promise<WebRuntimeTerminalCreateOutcome> {
  const created = await createHostTerminal(args)
  if (created.outcome.status !== 'failed' && created.hostTabId) {
    seedNativeChatLaunchDraftForAgentTab({
      tabId: toWebTerminalSurfaceTabId(created.hostTabId),
      agent: args.agent,
      text: args.launchDraft
    })
  }
  return created.outcome
}
