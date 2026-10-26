import {
  AGENT_CHAT_PERMISSION_MODES,
  agentChatPermissionModes,
  isAgentChatPermissionMode,
  type AgentChatPermissionMode
} from './agent-chat-permission-mode'
import {
  resolveTuiAgentLaunchArgs,
  tuiAgentArgsBypassPermissions
} from './tui-agent-launch-defaults'
import type { AgentStartupShell } from './tui-agent-startup-shell'
import { isTuiAgent } from './tui-agent-config'

/** Every shell a host could parse its arguments with: any one granting bypass counts. */
const HOST_STARTUP_SHELLS: readonly AgentStartupShell[] = ['posix', 'powershell', 'cmd']

/** Whether a host's own settings (`settings.get`) show it applies per-chat modes. */
export function hostSettingsApplyChatPermissionModes(settings: unknown): boolean {
  return (
    typeof settings === 'object' &&
    settings !== null &&
    'nativeChatPermissionMode' in settings &&
    isAgentChatPermissionMode(settings.nativeChatPermissionMode)
  )
}

/** Older hosts use Full access if any startup shell parses a bypass flag, otherwise Ask; null for agents without chat modes. */
export function legacyHostChatPermissionMode(
  agent: string,
  settings: unknown
): AgentChatPermissionMode | null {
  if (!agentChatPermissionModes(agent) || !isTuiAgent(agent)) {
    return null
  }
  const configured =
    typeof settings === 'object' && settings !== null && 'agentDefaultArgs' in settings
      ? settings.agentDefaultArgs
      : undefined
  const raw =
    typeof configured === 'object' && configured !== null && agent in configured
      ? Object.getOwnPropertyDescriptor(configured, agent)?.value
      : undefined
  const args = resolveTuiAgentLaunchArgs(agent, {
    agentDefaultArgs: typeof raw === 'string' ? { [agent]: raw } : {}
  })
  return HOST_STARTUP_SHELLS.some((shell) => tuiAgentArgsBypassPermissions(agent, args, shell))
    ? 'full-access'
    : 'ask'
}

function accessRank(mode: AgentChatPermissionMode): number {
  return AGENT_CHAT_PERMISSION_MODES.indexOf(mode)
}

/** What the host may be asked to run. `refused` names the access the host would grant instead. */
export type ChatPermissionHostVerdict =
  | { kind: 'allowed' }
  | { kind: 'refused'; hostMode: AgentChatPermissionMode | null }

/** Older hosts may grant no more access than requested; unknown legacyMode refuses rather than assuming strict permissions. */
export function chatPermissionHostVerdict(args: {
  agent: string
  hostAppliesModes: boolean
  legacyMode: AgentChatPermissionMode | null | undefined
  requested: unknown
}): ChatPermissionHostVerdict {
  if (args.hostAppliesModes || !agentChatPermissionModes(args.agent) || args.legacyMode === null) {
    return { kind: 'allowed' }
  }
  const requested = isAgentChatPermissionMode(args.requested) ? args.requested : 'ask'
  if (args.legacyMode !== undefined && accessRank(args.legacyMode) <= accessRank(requested)) {
    return { kind: 'allowed' }
  }
  return { kind: 'refused', hostMode: args.legacyMode ?? null }
}
