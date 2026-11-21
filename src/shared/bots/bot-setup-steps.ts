// A new bot's setup after it exists, as its first screen lists it: its agent starting, then its first
// message. Read from the kickoff turn's own journal rows, so a network retry or a failure shows with
// the agent's words instead of a step that looks done while nothing happens.
import type { NativeChatMessage } from '../native-chat/native-chat-types'
import { agentSessionFailureDetailText } from '../agent-session/failures/agent-session-failure-quoted-detail'
import type { AgentSessionAccountKind } from '../agent-session/failures/agent-session-availability'

export type BotSetupStepState = 'pending' | 'running' | 'done' | 'failed'

/** `detail`: the latest status line about the step (a retry, a failure), as the agent reported it.
 *  `providerDetail`: the agent's own words behind a failure, such as why its CLI exited. */
export type BotSetupStep = { state: BotSetupStepState; detail?: string; providerDetail?: string }

/** Why the host refused the kickoff before any turn opened, with the agent's own words when it has
 *  them; `notSignedIn` names the account a refusal for a missing sign-in is about. */
export type BotSetupRefusal = {
  reason: string
  providerDetail?: string
  /** The refusal's failure kind, which picks the action that fixes it. */
  kind?: string
  notSignedIn?: { account?: AgentSessionAccountKind }
}

type Problem = { detail?: string; providerDetail?: string }

export type BotSetupSteps = { start: BotSetupStep; reply: BotSetupStep }

const PROBLEM_TONES: ReadonlySet<string> = new Set(['warning', 'error', 'failed', 'failure'])

function problemOf(message: NativeChatMessage): Problem | null {
  if (message.role !== 'system') {
    return null
  }
  for (const block of message.blocks) {
    if (
      block.type === 'text' &&
      block.text.trim() !== '' &&
      (block.failure !== undefined || (block.tone !== undefined && PROBLEM_TONES.has(block.tone)))
    ) {
      return withProviderDetail(block.text, agentSessionFailureDetailText(block.failure))
    }
  }
  return null
}

function withProviderDetail(text: string, providerDetail: string | undefined): Problem {
  const detail = text.trim()
  const words = providerDetail?.trim()
  return {
    ...(detail ? { detail } : {}),
    ...(words && words !== detail ? { providerDetail: words } : {})
  }
}

/** `turn`: the kickoff turn's rows so far. `ended`: it ended without the bot's words. `agentReady`:
 *  the host says the agent is up. `refused`: why the kickoff was refused before any turn opened. */
export function botSetupSteps(input: {
  turn: readonly NativeChatMessage[]
  ended: boolean
  agentReady: boolean
  refused: BotSetupRefusal | null
}): BotSetupSteps {
  const { turn, ended, agentReady, refused } = input
  if (refused !== null) {
    return {
      start: {
        state: 'failed',
        ...withProviderDetail(refused.reason, refused.providerDetail)
      },
      reply: { state: 'pending' }
    }
  }
  // It answered (words or a tool call), so it is up even if the host's phase lags.
  const started = agentReady || turn.some((message) => message.role === 'assistant')
  // Ended, the last problem line says why; running, a retry line is current only while nothing came after it.
  const last = turn.at(-1)
  const problem = ended
    ? turn.flatMap((message) => problemOf(message) ?? []).at(-1)
    : last && problemOf(last)
  const step = (state: BotSetupStepState): BotSetupStep =>
    problem ? { state, ...problem } : { state }
  const now = step(ended ? 'failed' : 'running')
  return started
    ? { start: { state: 'done' }, reply: now }
    : { start: now, reply: { state: 'pending' } }
}
