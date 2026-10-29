import { createWebRuntimeSessionTerminalResult } from '@/runtime/web-runtime-terminal-create-operation'
import { webTerminalPlacementParentTabId } from '@/runtime/web-session-terminal-placement'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import {
  createWebRuntimeAgentSessionTerminal,
  createWebRuntimeAgentSessionTerminalWithLaunchDraft,
  type createWebRuntimeSessionTerminal
} from '@/runtime/web-runtime-terminal-creation'
import type { AgentStartupPlan } from '@/lib/tui-agent-startup'
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
export function launchAgentInWebHostTab(args: {
  agent: TuiAgent
  worktreeId: string
  environmentId: string | null
  groupId?: string
  cwd?: string | null
  startupPlan: AgentStartupPlan
  prompt: string
  promptDelivery: 'auto-submit' | 'draft' | 'submit-after-ready'
  pastePromptAfterReady: string | null
  submitPastedPrompt: boolean
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
    startupPlan,
    prompt,
    promptDelivery,
    pastePromptAfterReady,
    submitPastedPrompt,
    agentArgs,
    viewMode,
    onPromptDelivered
  } = args
  const hasPrompt = prompt.length > 0
  const launchPreferences = toAgentLaunchPreferences(startupPlan.sessionOptions, agent)
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
    // Why: with or without a prompt, the desktop's launch settings decide args (#31986).
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
    ...(launchPreferences?.mode
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
      toast.error(
        outcome.message ||
          translate(
            'auto.lib.launch.agent.in.new.tab.11cce5cc77',
            'Could not launch {{value0}} in a new terminal.',
            { value0: agent }
          )
      )
      return { delivered: false, failureNotified: true, outcome }
    }
    if (args.activate !== false) {
      useAppStore.getState().setActiveTabType('terminal', worktreeId)
    }
    if (hasPrompt && promptDelivered) {
      onPromptDelivered?.()
    }
    return {
      delivered: promptDelivered,
      failureNotified: false,
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
    }).then((outcome) => handleCreation({ outcome, promptDelivered: outcome.status === 'created' }))
  }
  return createWebRuntimeSessionTerminalResult(launch).then((created) =>
    handleCreation({
      ...created,
      promptDelivered: created.outcome.status === 'created' && hasPrompt
    })
  )
}
