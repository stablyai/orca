import { useState } from 'react'
import type { BotAgent } from '../../../../shared/bot-types'
import type { BotAgentSetup } from './BotAgentLaunchPicker'
import type { ExecutionHostId } from '../../../../shared/execution-host/execution-host'
import { agentChatPermissionModes } from '../../../../shared/agent-launch/permissions/agent-chat-permission-support'
import {
  savedChatPermissionMode,
  type AgentChatPermissionMode
} from '../../../../shared/agent-launch/permissions/agent-chat-permission-mode'

/** The owner's permission for the bot, whichever agent it ends up on: a mode, or the chats' own. */
export type BotPermissionIntent = AgentChatPermissionMode | 'inherit'

function offersPermissions(agent: BotAgent): boolean {
  return Boolean(agentChatPermissionModes(agent)?.modes.length)
}

/** The mode a bot with `intent` runs in on `agent`, as its chats resolve a saved override: the mode
 *  itself where the agent offers it, else Ask. None for the chats' own or an agent without modes. */
function effectiveMode(
  agent: BotAgent,
  intent: BotPermissionIntent
): AgentChatPermissionMode | undefined {
  const support = agentChatPermissionModes(agent)
  return support?.modes.length && intent !== 'inherit'
    ? savedChatPermissionMode(support, intent)
    : undefined
}

/** `setup` showing what `intent` runs as on its agent, so the picker never shows the chats' own for a
 *  kept mode the agent lacks. */
function withIntent(setup: BotAgentSetup, intent: BotPermissionIntent): BotAgentSetup {
  const { permissionMode: _shown, ...rest } = setup
  const mode = effectiveMode(setup.agent, intent)
  return mode ? { ...rest, permissionMode: mode } : rest
}

/** What a pick says about the owner's permission. A permission the owner chose is theirs, even the
 *  one already shown, and none chosen is the chats' own (so Use chat defaults clears a kept mode even
 *  on an agent with no permissions). Otherwise an agent with no permissions says nothing, and neither
 *  does a move to another agent that only dropped it, nor an edit (a model, an effort) that keeps the
 *  mode shown. Clearing the shown mode on the same agent chooses the chats' own. */
function nextIntent(
  intent: BotPermissionIntent,
  current: BotAgentSetup,
  next: BotAgentSetup,
  permissionPicked: boolean
): BotPermissionIntent {
  if (permissionPicked) {
    return next.permissionMode ?? 'inherit'
  }
  if (!offersPermissions(next.agent)) {
    return intent
  }
  if (next.agent !== current.agent) {
    return next.permissionMode && next.permissionMode !== effectiveMode(next.agent, intent)
      ? next.permissionMode
      : intent
  }
  if (!next.permissionMode) {
    return 'inherit'
  }
  return next.permissionMode === current.permissionMode ? intent : next.permissionMode
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
    /** `permissionPicked` when the owner chose the permission, even the one already shown. */
    setSetup: (next: BotAgentSetup, permissionPicked = false) => {
      if (intent !== undefined) {
        setIntent(nextIntent(intent, setup, next, permissionPicked))
      }
      setPicked({ hostId, setup: next })
    },
    reset: () => {
      setIntent(keptPermission)
      setPicked({ hostId: null, setup: first })
    }
  }
}
