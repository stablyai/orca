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

/** Toast host failure here because no mirrored pane can show it; callers reporting themselves use notifyFailure:false. */
export async function createWebRuntimeSessionTerminal(
  args: CreateWebRuntimeSessionTerminalArgs,
  options: { notifyFailure?: boolean } = {}
): Promise<WebRuntimeTerminalCreateOutcome> {
  const created = await createWebRuntimeSessionTerminalResult(args)
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
  const created = await createWebRuntimeSessionTerminalResult(args)
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

/** Argv-prefill carries draft in the command without post-ready paste; seed the composer once mirrored host tab ID is known. */
export async function createWebRuntimeAgentSessionTerminalWithLaunchDraft(
  args: CreateWebRuntimeSessionTerminalArgs & {
    agent: TuiAgent
    launchDraft: string
  }
): Promise<WebRuntimeTerminalCreateOutcome> {
  const created = await createWebRuntimeSessionTerminalResult(args)
  if (created.outcome.status !== 'failed' && created.hostTabId) {
    seedNativeChatLaunchDraftForAgentTab({
      tabId: toWebTerminalSurfaceTabId(created.hostTabId),
      agent: args.agent,
      text: args.launchDraft
    })
  }
  return created.outcome
}
