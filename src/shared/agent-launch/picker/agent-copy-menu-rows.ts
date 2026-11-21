import { applyAgentCopy, type AgentCopy } from '../catalog/agent-copies'
import type { TuiAgent } from '../catalog/tui-agent'
import {
  nativeChatPreferenceFor,
  type NativeChatDefaultSettings
} from '../choices/structured-native-chat-launch-route'
import type { NewTabAgentMenuRow } from './agent-launch-picker-rows'
import { LOCAL_EXECUTION_HOST_ID } from '../../execution-host/execution-host'

/** A copy opens on each surface its agent opens on: a chat where the agent's row offers one, a CLI
 *  wherever the agent is installed. Like its agent, it leads with a chat only when its own Chat |
 *  CLI choice in `settings` says chat; turned-off copies are not offered. */
export function agentCopyMenuRows(
  rows: readonly NewTabAgentMenuRow[],
  copies: readonly AgentCopy[],
  detected: readonly TuiAgent[] | null,
  settings?: NativeChatDefaultSettings | null
): NewTabAgentMenuRow[] {
  return copies.flatMap((copy) => {
    if (copy.disabled) {
      return []
    }
    const named = { id: copy.id, name: copy.name }
    const base = rows.filter((row) => row.agent === copy.agent)
    // Copies are this desktop's; a paired host refuses an id it does not have.
    if (
      base.some((row) => row.executionHostId && row.executionHostId !== LOCAL_EXECUTION_HOST_ID)
    ) {
      return []
    }
    const chat = base.some(
      (row) => row.kind === 'chat' || (row.kind === 'cli' && row.chat === true)
    )
    const asChat =
      chat && (!settings || nativeChatPreferenceFor(applyAgentCopy(settings, copy), copy.agent))
    const cli =
      base.some((row) => row.kind === 'cli' || row.kind === 'terminal') ||
      detected?.includes(copy.agent) === true
    const executionHostId = base[0]?.executionHostId
    const host = executionHostId ? { executionHostId } : {}
    return [
      ...(asChat ? [{ kind: 'chat' as const, agent: copy.agent, ...host, copy: named }] : []),
      ...(cli
        ? [
            chat || base.length > 0
              ? {
                  kind: 'cli' as const,
                  agent: copy.agent,
                  ...host,
                  ...(chat && !asChat ? { chat: true as const } : {}),
                  copy: named
                }
              : { kind: 'terminal' as const, agent: copy.agent, copy: named }
          ]
        : [])
    ]
  })
}
