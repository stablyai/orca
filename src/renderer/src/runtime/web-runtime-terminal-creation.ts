import { webTerminalPlacementParentTabId } from './web-session-terminal-placement'
import type { TuiAgent } from '../../../shared/agent-launch/catalog/tui-agent'
import {
  deliverLaunchPromptToAgentTab,
  seedNativeChatLaunchDraftForAgentTab
} from '../lib/agent-session/launch/prompt/agent-launch-prompt-delivery'
import { createWebRuntimeSessionTerminalResult } from './web-runtime-terminal-create-operation'
import { notifyWebRuntimeTerminalCreateFailure } from './web-runtime-terminal-create-failure-notice'
import { toWebTerminalSurfaceTabId } from '../../../shared/workspace-layout/terminal-surface-id'
import { startStoppedWslHostForUserAct, stoppedWslHostMessage } from '../lib/wsl-host-user-start'
import type {
  CreateWebRuntimeSessionTerminalArgs,
  CreatedWebRuntimeSessionTerminal,
  WebRuntimeTerminalCreateOutcome
} from './web-runtime-session-types'

/**
 * Toast host failure here because no mirrored pane can show it; callers reporting themselves use
 * notifyFailure:false. `userAct` marks a New Terminal the user asked for: it may start a stopped WSL
 * host, which nothing automatic does (E9).
 */
export async function createWebRuntimeSessionTerminal(
  args: CreateWebRuntimeSessionTerminalArgs,
  options: { notifyFailure?: boolean; userAct?: boolean } = {}
): Promise<WebRuntimeTerminalCreateOutcome> {
  if (options.userAct && !(await startStoppedWslHostForUserAct(args.environmentId))) {
    // The start already told the user why; the host is still stopped.
    return { status: 'failed', message: stoppedWslHostMessage(args.environmentId) }
  }
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

/** Deliver only after the selected create route has settled its startup recipe. */
export async function deliverCreatedWebRuntimeAgentSessionPrompt(
  created: CreatedWebRuntimeSessionTerminal,
  args: {
    agent: TuiAgent
    rendererTabId?: string
    beforePaste?: () => boolean
    launchPty?: Promise<string | null>
    promptAfterReady?: string
    submitPrompt?: boolean
    forcePromptPaste?: boolean
    launchDraft?: string
  }
): Promise<boolean> {
  if (created.outcome.status === 'failed') {
    return false
  }
  const tabId =
    args.rendererTabId ??
    (created.hostTabId
      ? toWebTerminalSurfaceTabId(webTerminalPlacementParentTabId(created.hostTabId))
      : undefined)
  if (args.promptAfterReady !== undefined) {
    if (!tabId) {
      return false
    }
    return await deliverLaunchPromptToAgentTab({
      tabId,
      content: args.promptAfterReady,
      agent: args.agent,
      submit: args.submitPrompt === true,
      forcePaste: args.forcePromptPaste === true,
      beforePaste: args.beforePaste,
      launchPty: args.launchPty
    }).catch(() => false)
  }
  if (args.launchDraft !== undefined && tabId) {
    seedNativeChatLaunchDraftForAgentTab({
      tabId,
      agent: args.agent,
      text: args.launchDraft
    })
  }
  return true
}
