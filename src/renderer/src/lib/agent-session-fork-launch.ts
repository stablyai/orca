import { useAppStore } from '@/store'
import { buildAgentResumeStartupPlan } from '@/lib/tui-agent-startup'
import { tuiAgentToAgentKind } from '@/lib/telemetry'
import { planAgentSessionLaunch } from '@/lib/agent-session-launch-plan'
import { launchAgentInNewTab } from '@/lib/launch-agent-in-new-tab'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import { preflightAgentTrust } from '@/lib/agent-trust-preflight'
import { getLocalProjectExecutionRuntimeContext } from '@/lib/local-preflight-context'
import { appendTabToWorktreeOrder } from '@/lib/sleeping-agent-session-launch'
import { createWebRuntimeSessionTerminal } from '@/runtime/web-runtime-session'
import { getForkAgentLaunchPlatform } from './agent-fork-launch-platform'
import {
  resolveTuiAgentLaunchArgs,
  resolveTuiAgentLaunchEnv
} from '../../../shared/tui-agent-launch-defaults'
import type { TuiAgent } from '../../../shared/tui-agent'
import { findForkWorktreeRepo } from './agent-session-fork-source-repo'
import { getForkAgentLaunchTarget } from './agent-session-fork-launch-target'
import type { ForkableAgentSession } from './worktree-agent-fork-sessions'

export type AgentForkLaunchSource = 'sidebar' | 'terminal_context_menu'

type NativeForkStartupPlan = NonNullable<ReturnType<typeof buildAgentResumeStartupPlan>>

// Why: a runtime-owned workspace's tabs are host-owned, so a local tab would never reach that host.
async function launchNativeForkOnRuntimeHost(args: {
  session: ForkableAgentSession
  worktreeId: string
  environmentId: string
  startupPlan: NativeForkStartupPlan
}): Promise<boolean> {
  const { session, startupPlan } = args
  // Why: 'resume' without a providerSession takes the host's command path and makes no resume claim.
  const outcome = await createWebRuntimeSessionTerminal({
    worktreeId: args.worktreeId,
    environmentId: args.environmentId,
    agentSessionKind: 'resume',
    launchAgent: session.agent,
    command: startupPlan.launchCommand,
    ...(startupPlan.env ? { env: startupPlan.env } : {}),
    launchConfig: startupPlan.launchConfig,
    ...(session.launchConfig ? { agentArgs: session.launchConfig.agentArgs } : {}),
    ...(startupPlan.startupCommandDelivery
      ? { startupCommandDelivery: startupPlan.startupCommandDelivery }
      : {}),
    // Why: omitted, the host applies its own default view and may open this terminal fork in chat.
    viewMode: 'terminal',
    activate: true
  })
  if (outcome.status !== 'created') {
    console.warn('[agent-session-fork] runtime host did not open the fork', outcome.message)
    return false
  }
  useAppStore.getState().setActiveTabType('terminal', args.worktreeId)
  return true
}

export async function launchNativeAgentSessionFork(args: {
  session: ForkableAgentSession
  worktreeId: string
  worktreePath: string
  connectionId: string | null
  launchSource: AgentForkLaunchSource
}): Promise<boolean> {
  const state = useAppStore.getState()
  const { session } = args
  const launchConfig = session.launchConfig
  // Why: the child worktree's host decides quoting (SSH/WSL → POSIX), not the source pane's.
  const target = getForkAgentLaunchTarget(state, args.worktreeId)
  const startupPlan = buildAgentResumeStartupPlan({
    agent: session.agent,
    providerSession: session.providerSession,
    cmdOverrides: state.settings?.agentCmdOverrides ?? {},
    agentArgs: launchConfig
      ? launchConfig.agentArgs
      : resolveTuiAgentLaunchArgs(session.agent, state.settings?.agentDefaultArgs),
    agentEnv: launchConfig
      ? launchConfig.agentEnv
      : resolveTuiAgentLaunchEnv(session.agent, state.settings?.agentDefaultEnv),
    ...(launchConfig?.agentCommand ? { agentCommand: launchConfig.agentCommand } : {}),
    platform: target.platform,
    shell: target.shell,
    mode: 'fork'
  })
  if (!startupPlan) {
    return false
  }
  if (target.runtimeEnvironmentId) {
    // Why: no local trust preflight — it writes the client's agent config, which the host never reads.
    return launchNativeForkOnRuntimeHost({
      session,
      worktreeId: args.worktreeId,
      environmentId: target.runtimeEnvironmentId,
      startupPlan
    })
  }
  // Why: a brand-new worktree path is untrusted until the agent's trust preflight runs there.
  await preflightAgentTrust({
    agent: session.agent,
    workspacePath: args.worktreePath,
    connectionId: args.connectionId ?? undefined
  })
  // Why: no resume claim — the fork gets a new session id and the source keeps its owner.
  const tab = state.createTab(args.worktreeId, undefined, undefined, {
    launchAgent: session.agent,
    pendingStartup: {
      command: startupPlan.launchCommand,
      ...(startupPlan.env ? { env: startupPlan.env } : {}),
      launchConfig: startupPlan.launchConfig,
      launchAgent: session.agent,
      ...(launchConfig ? { agentArgsOverride: launchConfig.agentArgs } : {}),
      ...(startupPlan.startupCommandDelivery
        ? { startupCommandDelivery: startupPlan.startupCommandDelivery }
        : {}),
      telemetry: {
        agent_kind: tuiAgentToAgentKind(session.agent),
        launch_source: args.launchSource,
        request_kind: 'resume'
      }
    }
  })
  state.setActiveTabType('terminal', args.worktreeId)
  appendTabToWorktreeOrder(args.worktreeId, tab.id)
  return true
}

export async function launchTranscriptAgentSessionFork(args: {
  agent: TuiAgent
  prompt: string
  worktreeId: string
  worktreePath: string
  launchSource: AgentForkLaunchSource
}): Promise<boolean> {
  const state = useAppStore.getState()
  const worktree = state.getKnownWorktreeById(args.worktreeId)
  const repo = (worktree ? findForkWorktreeRepo(state, worktree) : null) ?? undefined
  const agentSessionLaunchPlan = planAgentSessionLaunch(state, {
    agent: args.agent,
    workspace: { kind: 'git-worktree', worktreeId: args.worktreeId },
    prompt: args.prompt,
    promptDelivery: 'draft'
  })
  if (agentSessionLaunchPlan.route !== 'structured-native-chat') {
    await preflightAgentTrust({
      agent: args.agent,
      workspacePath: args.worktreePath,
      connectionId: repo?.connectionId
    })
  }
  const launchPlatform = getForkAgentLaunchPlatform({
    repo,
    worktreePath: args.worktreePath,
    projectRuntime: getLocalProjectExecutionRuntimeContext(state, args.worktreeId)
  })
  const result = launchAgentInNewTab({
    agent: args.agent,
    worktreeId: args.worktreeId,
    prompt: args.prompt,
    promptDelivery: 'draft',
    launchSource: args.launchSource,
    agentSessionLaunchPlan,
    beforeSurfaceOpen: (surface) =>
      activateAndRevealWorktree(args.worktreeId, {
        sidebarRevealBehavior: 'auto',
        ...(surface.kind === 'local-agent-session' ? { providesInitialSurface: true } : {})
      }) !== false,
    ...(launchPlatform ? { launchPlatform } : {})
  })
  return result !== null
}
