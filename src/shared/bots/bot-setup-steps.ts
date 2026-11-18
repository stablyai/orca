// A new bot's setup after it exists, as its first screen lists it: its agent starting, then its first
// message. Read from the kickoff turn's own journal rows, so a network retry or a failure shows with
// the agent's words instead of a step that looks done while nothing happens.
import type { NativeChatMessage } from '../native-chat/native-chat-types'

export type BotSetupStepState = 'pending' | 'running' | 'done' | 'failed'

/** `detail`: the latest status line about the step (a retry, a failure), as the agent reported it. */
export type BotSetupStep = { state: BotSetupStepState; detail?: string }

export type BotSetupSteps = { start: BotSetupStep; reply: BotSetupStep }

const PROBLEM_TONES: ReadonlySet<string> = new Set(['warning', 'error', 'failed', 'failure'])

function problemText(message: NativeChatMessage): string | null {
  if (message.role !== 'system') {
    return null
  }
  for (const block of message.blocks) {
    if (
      block.type === 'text' &&
      block.text.trim() !== '' &&
      (block.failure !== undefined || (block.tone !== undefined && PROBLEM_TONES.has(block.tone)))
    ) {
      return block.text.trim()
    }
  }
  return null
}

/** `turn`: the kickoff turn's rows so far. `ended`: it ended without the bot's words. `agentReady`:
 *  the host says the agent is up. `refused`: why the kickoff was refused before any turn opened. */
export function botSetupSteps(input: {
  turn: readonly NativeChatMessage[]
  ended: boolean
  agentReady: boolean
  refused: string | null
}): BotSetupSteps {
  const { turn, ended, agentReady, refused } = input
  if (refused !== null) {
    return {
      start: { state: 'failed', ...(refused.trim() ? { detail: refused.trim() } : {}) },
      reply: { state: 'pending' }
    }
  }
  // It answered (words or a tool call), so it is up even if the host's phase lags.
  const started = agentReady || turn.some((message) => message.role === 'assistant')
  // Ended, the last problem line says why; running, a retry line is current only while nothing came after it.
  const last = turn.at(-1)
  const problem = ended
    ? turn.flatMap((message) => problemText(message) ?? []).at(-1)
    : last && problemText(last)
  const step = (state: BotSetupStepState): BotSetupStep =>
    problem ? { state, detail: problem } : { state }
  const now = step(ended ? 'failed' : 'running')
  return started
    ? { start: { state: 'done' }, reply: now }
    : { start: now, reply: { state: 'pending' } }
}
