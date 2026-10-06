import type { StructuredAgentSessionOutboxEntry } from '../../../shared/structured-agent-session-outbox'
import { getStructuredAgentSessionOutbox } from '@/components/native-chat/structured-agent-session-outbox-storage'
import { watchStructuredAgentSessionOutboxEntry } from '@/components/native-chat/structured-agent-session-outbox-entry-watch'
import { structuredLaunchStates } from './structured-agent-session-launch-registry'

export type NewAgentPromptOutcome = { delivered: boolean }

function stagedLaunchPrompt(
  sessionId: string,
  text: string
): StructuredAgentSessionOutboxEntry | undefined {
  return getStructuredAgentSessionOutbox(sessionId).findLast(
    (entry) =>
      entry.source === 'launch' &&
      entry.body.blocks.some((block) => block.type === 'text' && block.text === text)
  )
}

/** A failed or unconfirmed chat keeps its prompt staged for its own Retry or re-check. */
function stagedInAnyLaunch(text: string): StructuredAgentSessionOutboxEntry | undefined {
  let found: StructuredAgentSessionOutboxEntry | undefined
  for (const state of structuredLaunchStates()) {
    found = stagedLaunchPrompt(state.intent.sessionId, text) ?? found
  }
  return found
}

function outcomeOf(entry: StructuredAgentSessionOutboxEntry): Promise<NewAgentPromptOutcome> {
  return new Promise((resolve) => {
    watchStructuredAgentSessionOutboxEntry(entry, (removal) =>
      resolve({ delivered: removal === 'spent' })
    )
  })
}

/**
 * Settles once a new agent's prompt is sent on (delivered) or thrown away with its chat. A chat's
 * staged prompt is the authority, so a Retry or re-check that sends it later still counts, and a
 * failed start does not hand the text back while that chat still holds it.
 */
export function newAgentPromptOutcome(args: {
  prompt: string
  sessionId?: string
  delivery: Promise<{ delivered: boolean }>
}): Promise<NewAgentPromptOutcome> {
  const text = args.prompt.trim()
  const staged = args.sessionId ? stagedLaunchPrompt(args.sessionId, text) : undefined
  if (staged) {
    return outcomeOf(staged)
  }
  // A paired server's chat exists only once it is admitted, so look again after the start.
  const afterStart = (
    delivered: boolean
  ): Promise<NewAgentPromptOutcome> | NewAgentPromptOutcome => {
    const kept = delivered ? undefined : stagedInAnyLaunch(text)
    return kept ? outcomeOf(kept) : { delivered }
  }
  return args.delivery.then(
    (result) => afterStart(result.delivered),
    () => afterStart(false)
  )
}
