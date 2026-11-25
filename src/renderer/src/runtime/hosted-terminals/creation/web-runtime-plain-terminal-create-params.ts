import { SESSION_TABS_CREATE_TERMINAL_SHELL_RUNTIME_CAPABILITY } from '../../../../../shared/remote-runtime/protocol/session-tabs-runtime-capabilities'
import { toHostSessionTabId } from '../../../../../shared/workspace-layout/terminal-surface-id'
import { translate } from '@/i18n/i18n'
import { runtimeEnvironmentSupportsCapability } from '../../rpc/compatibility/runtime-capability-proof'
import { toRuntimeWorktreeSelector } from '../../rpc/targets/runtime-worktree-selector'
import type { CreateWebRuntimeSessionTerminalArgs } from './terminal-create-contracts'

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
  // An explicit command may be quoted for the requested shell, not the host default.
  if (args.command !== undefined) {
    throw new Error(
      translate(
        'terminal.shellOverrideRequired',
        'This Orca server cannot run a command in the requested shell. Update the server and try again.'
      )
    )
  }
  // Old hosts drop shell; typing the pick still starts it inside their default shell.
  return { command: args.shell }
}

export async function buildPlainCreateTerminalParams(
  environmentId: string,
  args: CreateWebRuntimeSessionTerminalArgs
): Promise<Record<string, unknown>> {
  return {
    worktree: toRuntimeWorktreeSelector(args.worktreeId),
    afterTabId: args.afterTabId ? toHostSessionTabId(args.afterTabId) : undefined,
    targetGroupId: args.targetGroupId,
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
