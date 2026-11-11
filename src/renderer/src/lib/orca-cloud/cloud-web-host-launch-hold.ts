// Private layer, Orca Cloud only (RA-1). An Orca Cloud workspace is a paired web host: a Claude/Codex
// launch is published by the host (terminal.create) and the desktop only attaches, so the pane-spawn
// gate never runs. This holds the launch itself. When the agent's Orca-account sign-in expired (and no
// key covers it), the host opens a plain shell tab; its pane shows the account-recovery strip, and
// the agent starts in its place once Renew fixes it. Cancel leaves the plain shell.
import { toast } from 'sonner'
import type { TuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent'
import { toWebTerminalSurfaceTabId } from '../../../../shared/workspace-layout/terminal-surface-id'
import { createWebRuntimeSessionTerminalResult } from '@/runtime/hosted-terminals/creation/web-runtime-terminal-create-operation'
import { webTerminalPlacementParentTabId } from '@/runtime/hosted-terminals/placement/web-session-terminal-placement'
import { closeWebRuntimeSessionTab } from '@/runtime/web-session-tabs-sync/actions/web-runtime-session-tab-lifecycle'
import { translate } from '@/i18n/i18n'
import { launchAgentInWebHostTab } from '@/lib/agent-session/launch/new-tab/launch-agent-web-host-tab'
import { isOrcaCloudEnvironmentId } from './orca-cloud-environment-id'
import {
  cloudAgentLaunchDecision,
  cloudTabHoldKey,
  holdCloudAgentLaunch
} from './cloud-agent-launch-hold'

type WebHostLaunchResult = { delivered: boolean; failureNotified: boolean }

export type CloudWebHostLaunch = {
  agent: TuiAgent
  worktreeId: string
  environmentId: string
  groupId?: string
  cwd?: string | null
  prompt: string
  activate?: boolean
}

/**
 * Runs `launch` at once unless this is a Claude/Codex launch on Orca Cloud whose Orca-account
 * sign-in expired with no key to fall back to. Never throws; a failed placeholder launches as before.
 */
export async function launchWithCloudAgentHold<T extends WebHostLaunchResult>(
  request: CloudWebHostLaunch,
  launch: () => Promise<T>,
  cancelled: (placeholderCreated: boolean) => T
): Promise<T> {
  const { agent } = request
  if (
    (agent !== 'claude' && agent !== 'codex') ||
    !isOrcaCloudEnvironmentId(request.environmentId)
  ) {
    return launch()
  }
  if ((await cloudAgentLaunchDecision(agent)) !== 'hold') {
    return launch()
  }
  const placeholder = await createWebRuntimeSessionTerminalResult({
    worktreeId: request.worktreeId,
    environmentId: request.environmentId,
    ...(request.groupId ? { targetGroupId: request.groupId } : {}),
    ...(request.cwd?.trim() ? { cwd: request.cwd } : {}),
    ...(request.activate === false ? { activate: false } : {})
  }).catch(() => null)
  if (placeholder?.outcome.status !== 'created' || !placeholder.hostTabId) {
    // Nothing to hold the strip in: start as before rather than block the launch on a broken host.
    return launch()
  }
  const tabId = toWebTerminalSurfaceTabId(webTerminalPlacementParentTabId(placeholder.hostTabId))
  const outcome = await holdCloudAgentLaunch({
    paneKey: cloudTabHoldKey(tabId),
    agent,
    prompt: request.prompt.trim() || null,
    decided: true
  })
  if (outcome === 'cancel') {
    toast(
      translate(
        'agentSignInStrip.cancelledToast',
        'The agent didn’t start. The shell is still open.'
      )
    )
    return cancelled(true)
  }
  const launched = await launch()
  // The agent opened in its own tab; the placeholder shell has done its job.
  void closeWebRuntimeSessionTab({
    worktreeId: request.worktreeId,
    tabId,
    environmentId: request.environmentId,
    reason: 'user'
  }).catch(() => undefined)
  return launched
}

/** launchAgentInWebHostTab with the Orca Cloud account hold in front (same arguments and result). */
export function launchAgentInWebHostTabWithCloudHold(
  args: Parameters<typeof launchAgentInWebHostTab>[0]
): ReturnType<typeof launchAgentInWebHostTab> {
  const { environmentId } = args
  if (!environmentId) {
    return launchAgentInWebHostTab(args)
  }
  return launchWithCloudAgentHold(
    {
      agent: args.agent,
      worktreeId: args.worktreeId,
      environmentId,
      groupId: args.groupId,
      cwd: args.cwd,
      prompt: args.prompt,
      activate: args.activate
    },
    () => launchAgentInWebHostTab(args),
    () => ({ delivered: false, failureNotified: true, outcome: { status: 'failed', message: '' } })
  )
}
