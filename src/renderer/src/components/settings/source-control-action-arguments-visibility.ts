import type { NativeChatDefaultSettings } from '../../../../shared/structured-native-chat-launch-route'
import { isNativeChatDefaultFor } from '../../../../shared/structured-native-chat-launch-route'
import type { TuiAgent } from '../../../../shared/tui-agent'
import type { AgentLaunchSurface } from '@/lib/agent-session-launch-plan'

/** Settings knows the default surface; workspace-specific terminal fallback stays a launch decision. */
export function shouldShowSourceControlActionArguments({
  agent,
  settings,
  chatAgents,
  launchKind
}: {
  agent: TuiAgent | null | undefined
  settings: Partial<NativeChatDefaultSettings> | null | undefined
  chatAgents: readonly TuiAgent[]
  launchKind?: AgentLaunchSurface
}): boolean {
  return Boolean(
    agent &&
    (launchKind
      ? launchKind === 'terminal'
      : !isNativeChatDefaultFor(settings, agent) || !chatAgents.includes(agent))
  )
}
