import { toHostSessionTabId } from '../../../shared/workspace-layout/terminal-surface-id'
import { toRuntimeWorktreeSelector } from './runtime-worktree-selector'
import type { CreateWebRuntimeSessionTerminalArgs } from './web-runtime-session-types'

export function buildLegacyAgentCreateTerminalParams(
  args: CreateWebRuntimeSessionTerminalArgs,
  legacyAgentLaunch:
    | Awaited<ReturnType<NonNullable<CreateWebRuntimeSessionTerminalArgs['legacyAgentLaunch']>>>
    | undefined,
  trustOptions: { trustWorktreeId?: string }
) {
  const legacy = legacyAgentLaunch ?? args
  return {
    worktree: toRuntimeWorktreeSelector(args.worktreeId),
    ...trustOptions,
    afterTabId: args.afterTabId ? toHostSessionTabId(args.afterTabId) : undefined,
    targetGroupId: args.targetGroupId,
    ...(legacy.command ? { command: legacy.command } : {}),
    cwd: args.cwd,
    ...(legacy.env ? { env: legacy.env } : {}),
    ...(args.envToDelete ? { envToDelete: args.envToDelete } : {}),
    startupCommandDelivery: legacy.startupCommandDelivery,
    ...(legacy.launchConfig ? { launchConfig: legacy.launchConfig } : {}),
    ...(legacyAgentLaunch?.agentPrompt ? { agentPrompt: legacyAgentLaunch.agentPrompt } : {}),
    ...(args.launchToken ? { launchToken: args.launchToken } : {}),
    ...(args.agent ? { agent: args.agent } : {}),
    ...(args.launchAgent ? { launchAgent: args.launchAgent } : {}),
    ...(args.viewMode ? { viewMode: args.viewMode } : {}),
    // Old hosts use activate:false; new hosts use select/navigation for caller-local focus.
    activate: false,
    select: args.activate !== false,
    navigation: 'caller'
  }
}
