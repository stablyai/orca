import { useState } from 'react'
import type { BotAgent } from '../../../../shared/bot-types'
import type { BotAgentSetup } from './BotAgentLaunchPicker'
import type { ExecutionHostId } from '../../../../shared/execution-host/execution-host'

const FIRST_SETUP: BotAgentSetup = { agent: 'claude' }

/** A new bot's agent, model and permissions on `hostId`. Follows the first agent that computer has,
 *  on its defaults, until the owner picks one it has; a pick made for another computer starts over,
 *  since its model and options may not be offered there. */
export function useBotAgentSetup(
  choices: readonly BotAgent[],
  hostId: ExecutionHostId,
  initialAgent?: BotAgent
) {
  const first = initialAgent ? { agent: initialAgent } : FIRST_SETUP
  const [picked, setPicked] = useState<{ hostId: ExecutionHostId | null; setup: BotAgentSetup }>({
    hostId: null,
    setup: first
  })
  const own = picked.hostId === null || picked.hostId === hostId ? picked.setup : first
  const setup = choices.includes(own.agent) ? own : { agent: choices[0] ?? own.agent }
  return {
    setup,
    setSetup: (next: BotAgentSetup) => setPicked({ hostId, setup: next }),
    reset: () => setPicked({ hostId: null, setup: first })
  }
}
