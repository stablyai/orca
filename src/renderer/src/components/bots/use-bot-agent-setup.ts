import { useState } from 'react'
import type { BotAgent } from '../../../../shared/bot-types'
import type { BotAgentSetup } from './BotAgentLaunchPicker'
import type { ExecutionHostId } from '../../../../shared/execution-host/execution-host'
import { agentChatPermissionModes } from '../../../../shared/agent-launch/permissions/agent-chat-permission-support'
import type { AgentChatPermissionMode } from '../../../../shared/agent-launch/permissions/agent-chat-permission-mode'

/** The owner's permission for the bot, whichever agent it ends up on: a mode, or the chats' own. */
export type BotPermissionIntent = AgentChatPermissionMode | 'inherit'

function offersPermissions(agent: BotAgent): boolean {
  return Boolean(agentChatPermissionModes(agent)?.modes.length)
}

/** `setup` with `intent` as its permission, where its agent offers that mode. */
function withIntent(setup: BotAgentSetup, intent: BotPermissionIntent): BotAgentSetup {
  const { permissionMode: _shown, ...rest } = setup
  const offered = agentChatPermissionModes(setup.agent)?.modes.find((mode) => mode === intent)
  return offered ? { ...rest, permissionMode: offered } : rest
}

/** What a pick says about the owner's permission. An agent with no permissions says nothing, and
 *  neither does a move to another agent that only dropped it; clearing it on the same agent (Same as
 *  chats, Use chat defaults) chooses the chats' own. */
function nextIntent(
  intent: BotPermissionIntent,
  current: BotAgentSetup,
  next: BotAgentSetup
): BotPermissionIntent {
  if (!offersPermissions(next.agent)) {
    return intent
  }
  if (next.permissionMode) {
    return next.permissionMode
  }
  return next.agent === current.agent ? 'inherit' : intent
}

/** A new bot's agent, model and permissions on `hostId`. Follows the first agent that computer has,
 *  on its defaults, until the owner picks one it has; a pick made for another computer starts over,
 *  since its model and options may not be offered there.
 *  With `keptPermission` (a bot from a link), the owner's permission is kept apart from the agent:
 *  it starts there and follows every agent that offers it, until the owner picks another. */
export function useBotAgentSetup(
  choices: readonly BotAgent[],
  hostId: ExecutionHostId,
  initialAgent?: BotAgent,
  keptPermission?: AgentChatPermissionMode
) {
  const first: BotAgentSetup = { agent: initialAgent ?? 'claude' }
  const [picked, setPicked] = useState<{ hostId: ExecutionHostId | null; setup: BotAgentSetup }>({
    hostId: null,
    setup: first
  })
  const [intent, setIntent] = useState<BotPermissionIntent | undefined>(keptPermission)
  const own = picked.hostId === null || picked.hostId === hostId ? picked.setup : first
  const followed = choices.includes(own.agent) ? own : { agent: choices[0] ?? own.agent }
  const setup = intent === undefined ? followed : withIntent(followed, intent)
  return {
    setup,
    /** The permission Create writes for a kept one, even on an agent that can't offer it yet. */
    intent,
    setSetup: (next: BotAgentSetup) => {
      if (intent !== undefined) {
        setIntent(nextIntent(intent, setup, next))
      }
      setPicked({ hostId, setup: next })
    },
    reset: () => {
      setIntent(keptPermission)
      setPicked({ hostId: null, setup: first })
    }
  }
}
