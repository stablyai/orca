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
import type { NewTabAgentMenuModel } from '@/components/tab-bar/new-tab-agent-menu-model'

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
 * Picker rows for the Orca Cloud image. Terminal only: whether an agent's chat runs on the VM is
 * not knowable before the VM exists, and the terminal is what create launches there today.
 */
export function orcaCloudAgentMenuModel(
  settings: NewTabAgentMenuSettings | null | undefined
): Extract<NewTabAgentMenuModel, { state: 'settled' }> {
  const detectedIds: TuiAgent[] = [...ORCA_CLOUD_IMAGE_AGENTS]
  return {
    state: 'settled',
    rows: buildNewTabAgentMenuRows({
      settings,
      detectedOnHost: detectedIds,
      chatAgents: [],
      hostChatAnswer: () => 'no-chats',
      chatProgram: () => 'unknown'
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
