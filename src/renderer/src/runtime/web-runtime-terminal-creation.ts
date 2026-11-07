import type { TuiAgent } from '../../../shared/agent-launch/catalog/tui-agent'
import {
  deliverLaunchPromptToAgentTab,
  seedNativeChatLaunchDraftForAgentTab
} from '../lib/agent-session/launch/prompt/agent-launch-prompt-delivery'
import { createWebRuntimeSessionTerminalResult } from './web-runtime-terminal-create-operation'
import { resolveWebRuntimeSessionEnvironmentId } from './web-runtime-session-workspace-routing'
import { useAppStore } from '../store'
import { notifyWebRuntimeTerminalCreateFailure } from './web-runtime-terminal-create-failure-notice'
import { toWebTerminalSurfaceTabId } from '../../../shared/workspace-layout/terminal-surface-id'
import { startStoppedWslHostForUserAct, stoppedWslHostMessage } from '../lib/wsl-host-user-start'
import type {
  CreateWebRuntimeSessionTerminalArgs,
  CreateWebRuntimeSessionTerminalOnHostArgs,
  CreatedWebRuntimeSessionTerminal,
  WebRuntimeTerminalCreateOutcome
} from './web-runtime-session-types'

type TerminalCreateOptions = { notifyFailure?: boolean; userAct?: boolean }

/**
 * Toast host failure here because no mirrored pane can show it; callers reporting themselves use
 * notifyFailure:false. `userAct` marks a New Terminal the user asked for: it may start a stopped WSL
 * host, which nothing automatic does (E9).
 */
export async function createWebRuntimeSessionTerminal(
  args: CreateWebRuntimeSessionTerminalArgs,
  options: TerminalCreateOptions = {}
): Promise<WebRuntimeTerminalCreateOutcome> {
  return await createWebRuntimeTerminal(args, options, () =>
    createWebRuntimeSessionTerminalResult({
      ...args,
      environmentId: resolveWebRuntimeSessionEnvironmentId(
        args.environmentId,
        useAppStore.getState().settings?.activeRuntimeEnvironmentId
      )
    })
  )
}

export async function createWebRuntimeSessionTerminalOnHost(
  args: CreateWebRuntimeSessionTerminalOnHostArgs,
  options: TerminalCreateOptions = {}
): Promise<WebRuntimeTerminalCreateOutcome> {
  return await createWebRuntimeTerminal(args, options, () =>
    createWebRuntimeSessionTerminalResult(args)
  )
}

async function createWebRuntimeTerminal(
  args: CreateWebRuntimeSessionTerminalArgs,
  options: TerminalCreateOptions,
  create: () => Promise<CreatedWebRuntimeSessionTerminal>
): Promise<WebRuntimeTerminalCreateOutcome> {
  if (options.userAct && !(await startStoppedWslHostForUserAct(args.environmentId))) {
    // The start already told the user why; the host is still stopped.
    return { status: 'failed', message: stoppedWslHostMessage(args.environmentId) }
  }
  const created = await create()
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

/** Deliver only after the selected create route has settled its startup recipe. */
export async function deliverCreatedWebRuntimeAgentSessionPrompt(
  created: CreatedWebRuntimeSessionTerminal,
  args: {
    agent: TuiAgent
    promptAfterReady?: string
    submitPrompt?: boolean
    forcePromptPaste?: boolean
    launchDraft?: string
  }
): Promise<boolean> {
  if (created.outcome.status === 'failed') {
    return false
  }
  if (args.promptAfterReady !== undefined) {
    if (!created.hostTabId) {
      return false
    }
    return await deliverLaunchPromptToAgentTab({
      tabId: toWebTerminalSurfaceTabId(created.hostTabId),
      content: args.promptAfterReady,
      agent: args.agent,
      submit: args.submitPrompt === true,
      forcePaste: args.forcePromptPaste === true
    }).catch(() => false)
  }
  if (args.launchDraft !== undefined && created.hostTabId) {
    seedNativeChatLaunchDraftForAgentTab({
      tabId: toWebTerminalSurfaceTabId(created.hostTabId),
      agent: args.agent,
      text: args.launchDraft
    })
  }
  return true
}
