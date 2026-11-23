import { useAppStoreWithHostStatuses } from '@/store/slices/runtime-status/views/use-runtime-status-view'
import { getRendererAppPlatform } from '@/app-shell/platform/renderer-app-platform'
import { agentSessionSignInCommand } from '../../../../../shared/agent-session/lifecycle/launch/agent-session-setup-commands'
import type { AgentSessionAccountKind } from '../../../../../shared/agent-session/failures/agent-session-availability'
import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import { lastVerifiedRuntimeStatus } from '../../../../../shared/remote-runtime/host-status/runtime-host-status'
import { resolveHostAgentStartupShell } from '../../../../../shared/shell/launch/windows-terminal-shell'

/** The execution host selects the sign-in executable when it starts this command. */
export function useNativeChatSignInCommand(input: {
  agent: string
  target: RuntimeClientTarget
  account: AgentSessionAccountKind | undefined
}): string | null {
  const shell = useAppStoreWithHostStatuses((s, statuses) => {
    const status =
      input.target.kind === 'environment'
        ? lastVerifiedRuntimeStatus(statuses.get(input.target.environmentId))
        : null
    const platform = input.target.kind === 'local' ? getRendererAppPlatform() : status?.hostPlatform
    if (!platform) {
      return null
    }
    return (
      resolveHostAgentStartupShell({
        platform,
        isRemote: input.target.kind !== 'local',
        hostTerminalWindowsShell:
          input.target.kind === 'local'
            ? s.settings?.terminalWindowsShell
            : status?.terminalWindowsShell
      }) ?? (platform === 'win32' ? null : 'posix')
    )
  })
  return agentSessionSignInCommand(input.agent, {
    account: input.account,
    remote: input.target.kind !== 'local',
    shell
  })
}
