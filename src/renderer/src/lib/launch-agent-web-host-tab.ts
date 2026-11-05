import type { AgentLaunchChoices } from '../../../shared/agent-launch/choices/agent-launch-choices'
import { structuredAgentLabel } from './agent-session/launch/structured-agent-session-launch-label'
import type { SessionOptionValue } from '../../../shared/native-chat/input/native-chat-session-options'
import { ensureAgentLaunchPreferences } from '@/runtime/agent-launch-settings/use-host-agent-launch-preferences'
import { agentSessionCreateCapabilities } from '@/runtime/agent-session-create-request'
import { AGENT_SESSION_CREATE_OPTIONS_RUNTIME_CAPABILITY } from '../../../shared/agent-session/agent-session-runtime-capabilities'
import { isRuntimeCompatBlockError } from '@/runtime/runtime-protocol-compat'
import { getRuntimeEnvironmentRevision } from '@/runtime/runtime-environment-revision'
import { pairedAgentLaunchInputs } from './paired-agent-launch-inputs'
import { createWebRuntimeSessionTerminalResult } from '@/runtime/web-runtime-terminal-create-operation'
import { webTerminalPlacementParentTabId } from '@/runtime/web-session-terminal-placement'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import {
  deliverCreatedWebRuntimeAgentSessionPrompt,
  type createWebRuntimeSessionTerminal
} from '@/runtime/web-runtime-terminal-creation'
import type { CreateWebRuntimeSessionTerminalArgs } from '@/runtime/web-runtime-session-types'
import { planLaunchAgentStartupPrompt } from './launch-agent-startup-prompt-plan'
import { TUI_AGENT_CONFIG } from '../../../shared/agent-launch/catalog/tui-agent-config'
import type { LaunchAgentStartupPromptPlan } from '@/lib/launch-agent-startup-prompt-plan'
import type { Tab } from '../../../shared/tab-types'
import type { AgentStartupShell } from '../../../shared/agent-launch/startup/tui-agent-startup-shell'
import type { TuiAgent } from '../../../shared/agent-launch/catalog/tui-agent'
import { translate } from '@/i18n/i18n'
import { toWebTerminalSurfaceTabId } from '../../../shared/workspace-layout/terminal-surface-id'
import type { AgentTerminalLaunchCompletion } from './agent-session/launch/structured-agent-session-launch-admission'

/** Paired web tabs are host-owned; never create a local tab, and return tabId:null. */
export async function launchAgentInWebHostTab(args: {
  agent: TuiAgent
  worktreeId: string
  environmentId: string | null
  groupId?: string
  cwd?: string | null
  buildStartup: (choices: AgentLaunchChoices | undefined) => LaunchAgentStartupPromptPlan
  sessionOptions?: Readonly<Record<string, SessionOptionValue>>
  prompt: string
  promptDelivery: 'auto-submit' | 'draft' | 'submit-after-ready'
  agentArgs?: string | null
  actionAgentArgs?: string
  launchPlatform?: NodeJS.Platform
  launchShell?: AgentStartupShell
  viewMode?: Tab['viewMode']
  /** False opens the host's tab without selecting it. */
  activate?: boolean
  onPromptDelivered?: () => void
}): Promise<{ delivered: boolean; failureNotified: boolean } & AgentTerminalLaunchCompletion> {
  const {
    agent,
    worktreeId,
    environmentId,
    groupId,
    cwd,
    prompt,
    promptDelivery,
    agentArgs,
    viewMode,
    onPromptDelivered
  } = args
  const failureMessage = translate(
    'agentLaunch.terminalPreparationFailed',
    "Couldn't open a terminal for {{value0}}. Check the workspace connection and agent settings, then try again.",
    { value0: structuredAgentLabel(agent) }
  )
  const hasPrompt = prompt.length > 0
  const pairingRevision = environmentId ? getRuntimeEnvironmentRevision(environmentId) : undefined
  let startup: LaunchAgentStartupPromptPlan
  let launch: CreateWebRuntimeSessionTerminalArgs
  try {
    const { capable, complete } = environmentId
      ? await agentSessionCreateCapabilities(environmentId).catch((error: unknown) => {
          if (
            isRuntimeCompatBlockError(error) ||
            (error instanceof Error && error.name === 'AbortError')
          ) {
            throw error
          }
          return { capable: false, complete: false }
        })
      : { capable: false, complete: false }
    const inputs = environmentId
      ? await pairedAgentLaunchInputs({ ...args, environmentId, complete, capable })
      : { preparedAgentCommand: true }
    // Why: negotiation must not retarget this launch to a replacement pairing.
    if (environmentId && getRuntimeEnvironmentRevision(environmentId) !== pairingRevision) {
      throw new DOMException('Agent launch cancelled', 'AbortError')
    }
    // Why: only prompt delivery is client-owned; desktop launch settings belong to legacy preparation.
    startup = planLaunchAgentStartupPrompt({
      base: {
        agent,
        cmdOverrides: {},
        agentArgs: null,
        platform: args.launchPlatform ?? 'linux',
        shell: args.launchShell,
        isRemote: true
      },
      prompt,
      promptDelivery,
      isFollowupPath: TUI_AGENT_CONFIG[agent].promptInjectionMode === 'stdin-after-start'
    })
    launch = {
      worktreeId,
      environmentId,
      targetGroupId: groupId,
      activate: args.activate !== false,
      ...(!hasPrompt && args.activate === false ? { selectWorktree: false } : {}),
      ...(cwd?.trim() ? { cwd } : {}),
      ...(viewMode ? { viewMode } : {}),
      agentSessionKind: 'fresh',
      launchAgent: agent,
      agent,
      ...inputs,
      ...(complete
        ? { agentSessionCreateCapability: AGENT_SESSION_CREATE_OPTIONS_RUNTIME_CAPABILITY }
        : {}),
      ...(hasPrompt && startup.pasteDraftAfterLaunch === null ? { prompt } : {}),
      ...((hasPrompt && startup.pasteDraftAfterLaunch === null) ||
      promptDelivery === 'submit-after-ready'
        ? { promptDelivery: promptDelivery === 'draft' ? 'draft' : 'auto-submit' }
        : {}),
      legacyAgentLaunch: async () => {
        if (
          !Object.keys(args.sessionOptions ?? {}).length &&
          args.actionAgentArgs === undefined &&
          agentArgs === undefined &&
          (!hasPrompt || promptDelivery === 'auto-submit')
        ) {
          return hasPrompt && startup.pasteDraftAfterLaunch === null ? { agentPrompt: prompt } : {}
        }
        const preferences = await ensureAgentLaunchPreferences(useAppStore.getState(), {
          kind: 'git-worktree',
          worktreeId
        })
        startup = args.buildStartup(
          preferences.agentLaunchChoices ??
            (capable ? {} : useAppStore.getState().settings?.agentLaunchChoices)
        )
        const plan = startup.startupPlan
        if (!plan) {
          throw new Error(failureMessage)
        }
        return {
          command: plan.launchCommand,
          env: plan.env,
          launchConfig: plan.launchConfig,
          startupCommandDelivery: plan.startupCommandDelivery
        }
      }
    }
  } catch (error) {
    const cancelled = error instanceof Error && error.name === 'AbortError'
    if (!cancelled) {
      toast.error(failureMessage)
    }
    return {
      delivered: false,
      failureNotified: true,
      outcome: { status: 'failed', message: cancelled ? '' : failureMessage }
    }
  }

  const handleCreation = ({
    outcome,
    promptDelivered,
    hostTabId
  }: {
    outcome: Awaited<ReturnType<typeof createWebRuntimeSessionTerminal>>
    promptDelivered: boolean
    hostTabId?: string
  }): { delivered: boolean; failureNotified: boolean } & AgentTerminalLaunchCompletion => {
    if (outcome.status === 'failed') {
      toast.error(failureMessage)
      return { delivered: false, failureNotified: true, outcome }
    }
    if (args.activate !== false) {
      useAppStore.getState().setActiveTabType('terminal', worktreeId)
    }
    if (hasPrompt && promptDelivered) {
      onPromptDelivered?.()
    }
    const failureNotified = hasPrompt && !promptDelivered
    if (failureNotified) {
      toast.error(
        translate(
          'agentLaunch.terminalPromptFailed',
          'Orca opened a terminal for {{value0}}, but could not pass it your prompt. Send the prompt in that terminal.',
          { value0: structuredAgentLabel(agent) }
        )
      )
    }
    return {
      delivered: promptDelivered,
      failureNotified,
      outcome,
      ...(hostTabId
        ? { tabId: toWebTerminalSurfaceTabId(webTerminalPlacementParentTabId(hostTabId)) }
        : {})
    }
  }

  const created = await createWebRuntimeSessionTerminalResult(launch)
  const promptDelivered =
    hasPrompt &&
    (await deliverCreatedWebRuntimeAgentSessionPrompt(created, {
      agent,
      ...(startup.pasteDraftAfterLaunch !== null
        ? {
            promptAfterReady: startup.pasteDraftAfterLaunch,
            submitPrompt: startup.submitPastedPrompt,
            forcePromptPaste: true
          }
        : promptDelivery === 'draft'
          ? { launchDraft: prompt }
          : {})
    }))
  return handleCreation({ ...created, promptDelivered })
}
