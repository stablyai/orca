import { agentLaunchCommandErrorMessage } from '@/lib/launch-work-item-direct-messages'
import { toast } from 'sonner'
import {
  deliverLaunchPromptToAgentTab,
  seedNativeChatLaunchDraftForAgentTab
} from '@/lib/agent-launch-prompt-delivery'
import {
  buildDirectWorkItemAgentStartupPlan,
  notifyDirectWorkItemAgentStartTimeout
} from '@/lib/launch-work-item-direct-agent'
import { acquireAgentLaunchChoices } from './host-chat-program-acquisition'
import { useAppStore } from '@/store'
import type { TuiAgent } from '../../../shared/tui-agent'
import type { AppState } from '@/store/types'
import { isTuiAgent } from '../../../shared/tui-agent-config'
import { isTuiAgentEnabled, pickTuiAgent } from '../../../shared/tui-agent-selection'
import { worktreeLaunchWorkspace } from '@/lib/agent-launch-route-input'
import { agentChoiceMayOpenAsChat } from '@/lib/host-chat-program'
import type { AgentSessionLaunchPlan } from '@/lib/agent-session-launch-plan'
import {
  resolveExecutionHostAgentStartupShell,
  type KnownExecutionHostPlatform
} from '@/lib/execution-host-facts'
import { beginStructuredAgentSessionProvisionalLaunch } from '@/lib/agent-session/structured-agent-session-provisional-tab'
import type { DeclinedStructuredLaunchTerminalOptions } from '@/lib/structured-agent-session-launch-admission'
import {
  ensureDetectedAgentsForNewWorktree,
  type RepoHostFields
} from '@/lib/agent-detection-target-inventory'

export function buildDirectWorkItemStartup(args: {
  agent: TuiAgent | null
  agentArgs?: string | null
  sessionOptions?: Readonly<Record<string, string>>
  sessionOptionsYieldToAgentArgs?: true
  draftContent: string
  promptDelivery: PromptDelivery
  settings: AppState['settings']
  /** The workspace's execution host; its OS and shell decide quoting, not this client's. */
  launchHost: KnownExecutionHostPlatform
  /** This client's Windows shell, which only shapes a local launch. */
  terminalWindowsShell: string | null | undefined
  launchConnectionId: string | null
}): ReturnType<typeof buildDirectWorkItemAgentStartupPlan> {
  const shell = resolveExecutionHostAgentStartupShell(args.launchHost, args.terminalWindowsShell)
  return buildDirectWorkItemAgentStartupPlan({
    agent: args.agent,
    agentArgs: args.agentArgs,
    sessionOptions: args.sessionOptions,
    sessionOptionsYieldToAgentArgs: args.sessionOptionsYieldToAgentArgs,
    draftContent: args.draftContent,
    promptDelivery: args.promptDelivery,
    settings: args.settings,
    launchPlatform: args.launchHost.platform,
    ...(shell ? { shell } : {}),
    // Why: SSH hosts run the plain `orca` shim, so the Linux-only `orca-ide` rename is not applied.
    isRemote: typeof args.launchConnectionId === 'string'
  })
}

type PromptDelivery = 'draft' | 'submit-after-ready'

export async function resolveDirectWorkItemAgent(args: {
  agentOverride?: TuiAgent
  worktreeId: string
  repoHost: RepoHostFields
  launchConnectionId: string | null
  repoConnectionId: string | null
  detectedAgentsPromise: Promise<string[]> | null
  latestStore: AppState
}): Promise<{ agent: TuiAgent | null; unavailable: boolean }> {
  // Why: the new workspace's own host answers; a paired server's project must not probe this client.
  const workspace = worktreeLaunchWorkspace(args.worktreeId)
  const ids = (
    args.agentOverride === undefined &&
    args.detectedAgentsPromise &&
    args.launchConnectionId === args.repoConnectionId
      ? await args.detectedAgentsPromise
      : await ensureDetectedAgentsForNewWorktree(args.latestStore, args.worktreeId, args.repoHost)
  ).filter(isTuiAgent)
  const wanted = args.agentOverride ?? useAppStore.getState().settings?.defaultTuiAgent
  // Chat facts can only change the pick when the wanted agent's CLI is not detected.
  const choices =
    wanted && wanted !== 'blank' && !ids.includes(wanted)
      ? await acquireAgentLaunchChoices(workspace, async () => ids)
      : null
  const store = useAppStore.getState()
  // A new workspace may not be in the store yet; its own detection answers then.
  const detected = [...(choices?.detected ?? ids)]
  // A chosen agent may open as a chat without its CLI; the automatic pick stays on detected ones.
  if (args.agentOverride !== undefined) {
    return {
      agent: args.agentOverride,
      unavailable:
        !isTuiAgentEnabled(args.agentOverride, store.settings?.disabledTuiAgents) ||
        (!detected.includes(args.agentOverride) &&
          !agentChoiceMayOpenAsChat(store, args.agentOverride, workspace, detected))
    }
  }
  return {
    agent: pickTuiAgent(
      store.settings?.defaultTuiAgent,
      detected,
      store.settings?.disabledTuiAgents,
      (chosen) => agentChoiceMayOpenAsChat(store, chosen, workspace, detected)
    ),
    unavailable: false
  }
}

export function beginDirectWorkItemStructuredLaunch(args: {
  plan: AgentSessionLaunchPlan | null
  primaryTabId: string | null
  beforeOpen: (sessionId?: string) => boolean | void
  /** The terminal launch the host's "no" falls back to, carrying the caller's own CLI args. */
  declinedTerminal?: DeclinedStructuredLaunchTerminalOptions
}): {
  completed: boolean
  structuredLaunch: boolean
  primaryTabId: string | null
} {
  const { plan } = args
  const notLaunched = (structuredLaunch: boolean) => ({
    completed: false,
    structuredLaunch,
    primaryTabId: args.primaryTabId
  })
  if (plan?.route !== 'structured-native-chat') {
    return notLaunched(false)
  }
  const launch = beginStructuredAgentSessionProvisionalLaunch({
    plan,
    hooks: {},
    beforeOpen: args.beforeOpen,
    ...(args.declinedTerminal ? { declinedTerminal: args.declinedTerminal } : {})
  })
  if (!launch) {
    return notLaunched(true)
  }
  return {
    completed: true,
    structuredLaunch: true,
    primaryTabId: launch.tab?.id ?? args.primaryTabId
  }
}

export function finishDirectWorkItemPrompt(args: {
  primaryTabId: string | null
  effectiveAgent: TuiAgent | null
  promptDelivery: PromptDelivery
  draftContent: string
  startupPlan: ReturnType<typeof buildDirectWorkItemAgentStartupPlan>['startupPlan']
  draftLaunchedNatively: boolean
  startupPlanFailed: boolean
}): boolean {
  const {
    primaryTabId,
    effectiveAgent,
    promptDelivery,
    draftContent,
    startupPlan,
    draftLaunchedNatively,
    startupPlanFailed
  } = args
  if (startupPlanFailed) {
    toast.error(agentLaunchCommandErrorMessage())
    return false
  }

  if (primaryTabId && effectiveAgent && promptDelivery === 'draft') {
    // Why: the draft rides in on argv or the startup payload, so no paste runs
    // below; mirror it into chat the way the new-tab launcher does.
    seedNativeChatLaunchDraftForAgentTab({
      tabId: primaryTabId,
      agent: effectiveAgent,
      text: draftContent
    })
  }
  if (
    primaryTabId &&
    startupPlan &&
    !draftLaunchedNatively &&
    !(promptDelivery === 'draft' && startupPlan.draftPrompt)
  ) {
    const submit = promptDelivery === 'submit-after-ready'
    const agent = startupPlan.agent
    void deliverLaunchPromptToAgentTab({
      tabId: primaryTabId,
      agent,
      content: draftContent,
      submit,
      forcePaste: submit,
      onTimeout: () => notifyDirectWorkItemAgentStartTimeout(agent, submit)
    })
  }
  return true
}
