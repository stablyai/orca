import { useAppStore } from '@/store'
import { workspaceProtocolPlacement } from './workspace-command-address'
import { SESSION_TABS_CREATE_TERMINAL_SHELL_RUNTIME_CAPABILITY } from '../../../shared/session-tabs-runtime-capabilities'
import { toHostSessionTabId } from '../../../shared/terminal-surface-id'
import { runtimeEnvironmentSupportsCapability } from './runtime-rpc-client'
import { toRuntimeWorktreeSelector } from './runtime-worktree-selector'
import type { CreateWebRuntimeSessionTerminalArgs } from './web-runtime-session-types'

export type CreateTerminalShellParams = { command?: string; shell?: string }

export async function resolveCreateTerminalShellParams(
  environmentId: string,
  args: { command?: string; shell?: string }
): Promise<CreateTerminalShellParams> {
  if (!args.shell) {
    return { command: args.command }
  }
  if (
    await runtimeEnvironmentSupportsCapability(
      environmentId,
      SESSION_TABS_CREATE_TERMINAL_SHELL_RUNTIME_CAPABILITY
    )
  ) {
    return { command: args.command, shell: args.shell }
  }
  // Old hosts drop shell; typing the pick still starts it inside their default shell.
  return { command: args.command ?? args.shell }
}

export async function buildPlainCreateTerminalParams(
  environmentId: string,
  args: CreateWebRuntimeSessionTerminalArgs
): Promise<Record<string, unknown>> {
  const placement = workspaceProtocolPlacement(
    useAppStore.getState(),
    environmentId,
    args.worktreeId,
    args.targetGroupId,
    args.afterTabId
  )
  return {
    worktree: toRuntimeWorktreeSelector(args.worktreeId),
    afterTabId: placement.afterTabId ? toHostSessionTabId(placement.afterTabId) : undefined,
    targetGroupId: placement.targetGroupId,
    ...(await resolveCreateTerminalShellParams(environmentId, args)),
    cwd: args.cwd,
    ...(args.env ? { env: args.env } : {}),
    ...(args.envToDelete ? { envToDelete: args.envToDelete } : {}),
    startupCommandDelivery: args.startupCommandDelivery,
    ...(args.launchConfig ? { launchConfig: args.launchConfig } : {}),
    ...(args.launchToken ? { launchToken: args.launchToken } : {}),
    ...(args.viewMode ? { viewMode: args.viewMode } : {}),
    // Old hosts use activate:false; new hosts use select/navigation for caller-local focus.
    activate: false,
    select: args.activate !== false,
    navigation: 'caller'
  }
}
