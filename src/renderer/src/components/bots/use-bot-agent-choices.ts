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
import { useWslHostDistro } from '@/components/wsl-host-mark/WslHostMark'

/** The host's agent menu, for the bot agent picker, and the agents a bot can be set to there. */
export function useBotAgentMenu(
  hostId: ExecutionHostId,
  open: boolean,
  current?: BotAgent,
  installedOnly = false
): { model: NewTabAgentMenuModel; choices: BotAgent[] } {
  // A bot lives in a folder workspace on its host.
  const home = useMemo<AgentMenuRowsTarget>(
    () => ({ workspace: { kind: 'folder', executionHostId: hostId } }),
    [hostId]
  )
  const detection = useMemo<AgentDetectionTarget>(() => {
    const target = botHostTarget(hostId)
    return target.kind === 'environment'
      ? { kind: 'runtime', environmentId: target.environmentId }
      : target
  }, [hostId])
  const model = useNewTabAgentMenuRows(home, open, detection)
  return { model, choices: botAgentChoices(model, current, installedOnly) }
}

/** The agents a bot can be set to on the host; see `botAgentChoices`. */
export function useBotAgentChoices(
  hostId: ExecutionHostId,
  open: boolean,
  current?: BotAgent
): BotAgent[] {
  return useBotAgentMenu(hostId, open, current).choices
}

/** New bot's menu: on a WSL host, whose install chats offer agents only Windows has, only installed agents. */
export function useNewBotAgentMenu(
  hostId: ExecutionHostId,
  open: boolean
): { model: NewTabAgentMenuModel; choices: BotAgent[] } {
  return useBotAgentMenu(hostId, open, undefined, useWslHostDistro(hostId) !== null)
}
