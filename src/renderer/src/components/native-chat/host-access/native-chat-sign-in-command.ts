import { useSyncExternalStore } from 'react'
import { useAppStoreWithHostStatuses } from '@/store/slices/runtime-status/views/use-runtime-status-view'
import { getRendererAppPlatform } from '@/app-shell/platform/renderer-app-platform'
import {
  LOCAL_MANAGED_AGENT_HOST,
  readManagedAgentCommands,
  runtimeManagedAgentHost,
  subscribeManagedAgentCommands
} from '@/store/slices/agent-inventory/managed-agent-launch-commands'
import { isTuiAgent } from '../../../../../shared/agent-launch/catalog/tui-agent-config'
import { agentSessionSignInCommand } from '../../../../../shared/agent-session/lifecycle/launch/agent-session-setup-commands'
import type { AgentSessionAccountKind } from '../../../../../shared/agent-session/failures/agent-session-availability'
import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import { lastVerifiedRuntimeStatus } from '../../../../../shared/remote-runtime/host-status/runtime-host-status'
import { resolveHostAgentStartupShell } from '../../../../../shared/shell/launch/windows-terminal-shell'

/** The sign-in terminal's line on the chat's host, quoted for its shell; runs Orca's copy by full
 *  path where the host has no CLI of the user's own. */
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
  const host =
    input.target.kind === 'local'
      ? LOCAL_MANAGED_AGENT_HOST
      : runtimeManagedAgentHost(input.target.environmentId)
  const managedCommand = useSyncExternalStore(subscribeManagedAgentCommands, () =>
    isTuiAgent(input.agent) ? (readManagedAgentCommands(host)?.[input.agent] ?? null) : null
  )
  return agentSessionSignInCommand(input.agent, {
    account: input.account,
    remote: input.target.kind !== 'local',
    shell,
    managedCommand
  })
}
