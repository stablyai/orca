import { useMemo } from 'react'
import { botHostTarget } from '@/lib/bot-hosts'
import type { ExecutionHostId } from '../../../../shared/execution-host/execution-host'
import type { AgentDetectionTarget } from '@/lib/agent-session/launch/inventory/useDetectedAgents'
import type { BotAgent } from '../../../../shared/bot-types'
import { useNewTabAgentMenuRows } from '../agent/launch-menu/use-new-tab-agent-menu-rows'
import type {
  AgentMenuRowsTarget,
  NewTabAgentMenuModel
} from '../agent/launch-menu/new-tab-agent-menu-model'
import { botAgentChoices } from '../../../../shared/bots/bot-agent-choices'

// A bot lives in a folder workspace on its host.
const BOT_HOME: AgentMenuRowsTarget = { workspace: { kind: 'folder' } }

/** The host's agent menu, for the bot agent picker, and the agents a bot can be set to there. */
export function useBotAgentMenu(
  hostId: ExecutionHostId,
  open: boolean,
  current?: BotAgent
): { model: NewTabAgentMenuModel; choices: BotAgent[] } {
  const detection = useMemo<AgentDetectionTarget>(() => {
    const target = botHostTarget(hostId)
    return target.kind === 'environment'
      ? { kind: 'runtime', environmentId: target.environmentId }
      : target
  }, [hostId])
  const model = useNewTabAgentMenuRows(BOT_HOME, open, detection)
  return { model, choices: botAgentChoices(model, current) }
}

/** The agents a bot can be set to on the host; see `botAgentChoices`. */
export function useBotAgentChoices(
  hostId: ExecutionHostId,
  open: boolean,
  current?: BotAgent
): BotAgent[] {
  return useBotAgentMenu(hostId, open, current).choices
}
