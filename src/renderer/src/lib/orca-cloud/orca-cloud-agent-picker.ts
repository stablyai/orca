import type { TuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent'
import { pickTuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent-selection'
import {
  buildNewTabAgentMenuRows,
  type NewTabAgentMenuSettings
} from '../../../../shared/agent-launch/picker/agent-launch-picker-rows'
import {
  ORCA_CLOUD_DEFAULT_AGENT,
  ORCA_CLOUD_IMAGE_AGENTS,
  isOrcaCloudImageAgent
} from '../../../../shared/hosted-sandbox/orca-cloud-image-agents'
import type { AgentPickerDefaultSettings } from '../../../../shared/agent-launch/picker/agent-launch-picker-defaults'
import { isNativeChatSupportedAgent } from '../../../../shared/native-chat/native-chat-agent-support'
import { resolveAgentMenuSelection } from '@/lib/agent-session/launch/routing/agent-menu-selection'
import type { AgentLaunchSurface } from '@/lib/agent-session/launch/routing/agent-session-launch-plan'
import type { NewTabAgentMenuModel } from '@/components/agent/launch-menu/new-tab-agent-menu-model'

/**
 * The agents an Orca Cloud workspace can start before its VM exists: the image ships them, so the
 * composer treats them as installed instead of asking this desktop which CLIs it has.
 */
export const ORCA_CLOUD_AGENT_IDS: ReadonlySet<TuiAgent> = new Set(ORCA_CLOUD_IMAGE_AGENTS)

/** The user's default when the image ships it (or Blank Terminal), else the cloud default. */
export function pickOrcaCloudAgent(
  preferred: TuiAgent | 'blank' | null | undefined,
  disabledTuiAgents?: Iterable<unknown> | null
): TuiAgent | null {
  const start =
    preferred === 'blank' || (preferred && isOrcaCloudImageAgent(preferred))
      ? preferred
      : ORCA_CLOUD_DEFAULT_AGENT
  return pickTuiAgent(start, ORCA_CLOUD_IMAGE_AGENTS, disabledTuiAgents)
}

/**
 * Stands in for the VM's host before it exists. It names no host, so the picker's per-agent setup
 * offers the built-in model and option catalog instead of asking this computer's CLIs.
 */
export const ORCA_CLOUD_PICKER_HOST = 'orca-cloud'

/** The image agents that also open as a native chat on an Orca Cloud workspace. */
const ORCA_CLOUD_CHAT_AGENTS: readonly TuiAgent[] = ORCA_CLOUD_IMAGE_AGENTS.filter(
  isNativeChatSupportedAgent
)

/**
 * Picker rows for the Orca Cloud image: every image agent as a terminal, and as a chat where it has
 * one. The image ships each agent, so its chat runs there; a VM that refuses the chat after all (an
 * older image) falls back to its terminal.
 */
export function orcaCloudAgentMenuModel(
  settings: (NewTabAgentMenuSettings & AgentPickerDefaultSettings) | null | undefined
): Extract<NewTabAgentMenuModel, { state: 'settled' }> {
  const detectedIds: TuiAgent[] = [...ORCA_CLOUD_IMAGE_AGENTS]
  return {
    state: 'settled',
    pickerContext: {
      workspace: { kind: 'git-worktree' },
      executionHostId: ORCA_CLOUD_PICKER_HOST,
      settings: settings ?? null,
      key: ORCA_CLOUD_PICKER_HOST
    },
    rows: buildNewTabAgentMenuRows({
      settings,
      detectedOnHost: detectedIds,
      chatAgents: ORCA_CLOUD_CHAT_AGENTS,
      hostChatAnswer: () => 'yes',
      chatProgram: () => 'available'
    }),
    detection: {
      detectedIds,
      isLoading: false,
      detectionFailed: false,
      isRefreshing: false,
      needsServerUpdate: false,
      refresh: async () => detectedIds
    },
    defaultTuiAgent: settings?.defaultTuiAgent
  }
}

/** The composer's chat-or-terminal choice for Orca Cloud, read from the image, not this computer. */
export function orcaCloudAgentSelection(
  agent: TuiAgent | null,
  surface: AgentLaunchSurface | undefined,
  settings: NewTabAgentMenuSettings | null | undefined
): ReturnType<typeof resolveAgentMenuSelection> {
  const chat = agent !== null && ORCA_CLOUD_CHAT_AGENTS.includes(agent)
  return resolveAgentMenuSelection({
    agent,
    surface,
    settings,
    inventoryReady: true,
    answer: chat ? 'yes' : 'no-chats',
    chatPending: false,
    plain: !chat
  })
}
