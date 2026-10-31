import type { AgentLaunchChoices } from '../../../shared/agent-launch-choices'
import { structuredAgentLabel } from './structured-agent-session-launch-label'
import type { SessionOptionValue } from '../../../shared/native-chat/input/native-chat-session-options'
import { ensureAgentLaunchPreferences } from '@/components/settings/use-host-agent-launch-preferences'
import { hostSupportsLaunchChoices } from '@/components/settings/agent-launch-settings-transport'
import { createWebRuntimeSessionTerminalResult } from '@/runtime/web-runtime-terminal-create-operation'
import { webTerminalPlacementParentTabId } from '@/runtime/web-session-terminal-placement'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import {
  createWebRuntimeAgentSessionTerminal,
  createWebRuntimeAgentSessionTerminalWithLaunchDraft,
  type createWebRuntimeSessionTerminal
} from '@/runtime/web-runtime-terminal-creation'
import type { LaunchAgentStartupPromptPlan } from '@/lib/launch-agent-startup-prompt-plan'
import type { Tab } from '../../../shared/tab-types'
import type { TuiAgent } from '../../../shared/tui-agent'
import type { AgentPromptDelivery } from '../../../shared/agent-session-host-authority'
import { translate } from '@/i18n/i18n'
import { toWebTerminalSurfaceTabId } from '../../../shared/terminal-surface-id'
import type { AgentTerminalLaunchCompletion } from './structured-agent-session-launch-admission'
import {
  agentLaunchNeedsPreparedCommand,
  toAgentLaunchPreferences
} from '../../../shared/agent-launch-preferences'

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
  let capable: boolean
  let startup: LaunchAgentStartupPromptPlan
  try {
    capable = environmentId ? await hostSupportsLaunchChoices({ environmentId }) : false
    const preferences = await ensureAgentLaunchPreferences(useAppStore.getState(), {
      kind: 'git-worktree',
      worktreeId
    })
    startup = args.buildStartup(
      preferences.agentLaunchChoices ??
        (capable ? {} : useAppStore.getState().settings?.agentLaunchChoices)
    )
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
  const { startupPlan, pasteDraftAfterLaunch: pastePromptAfterReady, submitPastedPrompt } = startup
  if (!startupPlan) {
    toast.error(failureMessage)
    return {
      delivered: false,
      failureNotified: true,
      outcome: { status: 'failed', message: failureMessage }
    }
  }
  const hasPrompt = prompt.length > 0
  const launchPreferences = toAgentLaunchPreferences(
    capable ? args.sessionOptions : startupPlan.sessionOptions,
    agent
  )
  const structuredPromptDelivery: AgentPromptDelivery =
    promptDelivery === 'draft' ? 'draft' : 'auto-submit'
  const launch = {
    worktreeId,
    environmentId,
    targetGroupId: groupId,
    activate: args.activate !== false,
    ...(!hasPrompt && args.activate === false ? { selectWorktree: false } : {}),
    ...(cwd?.trim() ? { cwd } : {}),
    ...(viewMode ? { viewMode } : {}),
    agentSessionKind: 'fresh',
    // Prepared delivery retains caller settings; authoritative creation resolves the host defaults.
    launchAgent: agent,
    preparedAgentCommand: agentLaunchNeedsPreparedCommand(agent, startupPlan.sessionOptions),
    command: startupPlan.launchCommand,
    ...(startupPlan.env ? { env: startupPlan.env } : {}),
    launchConfig: startupPlan.launchConfig,
    ...(startupPlan.startupCommandDelivery
      ? { startupCommandDelivery: startupPlan.startupCommandDelivery }
      : {}),
    ...(hasPrompt && pastePromptAfterReady === null ? { prompt } : {}),
    ...(hasPrompt && pastePromptAfterReady === null
      ? { promptDelivery: structuredPromptDelivery }
      : {}),
    ...(!capable && launchPreferences?.mode
      ? { agentArgs: startupPlan.launchConfig.agentArgs }
      : agentArgs !== undefined
        ? { agentArgs }
        : {}),
    ...(launchPreferences ? { launchPreferences } : {})
  } as const

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

  if (pastePromptAfterReady !== null) {
    return createWebRuntimeAgentSessionTerminal({
      ...launch,
      agent,
      promptAfterReady: pastePromptAfterReady,
      submitPrompt: submitPastedPrompt,
      forcePromptPaste: true
    }).then(handleCreation)
  }
  if (hasPrompt && promptDelivery === 'draft') {
    // Native launch-command prefill skips paste, so explicitly seed this host class’s chat composer.
    return createWebRuntimeAgentSessionTerminalWithLaunchDraft({
      ...launch,
      agent,
      launchDraft: prompt
    }).then(handleCreation)
  }
  return createWebRuntimeSessionTerminalResult(launch).then((created) =>
    handleCreation({
      ...created,
      promptDelivered: created.outcome.status === 'created' && hasPrompt
    })
  )
}
