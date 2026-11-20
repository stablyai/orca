import type { AgentSessionTextAppendCapabilities } from './agent-session-text-append'
import { agentSessionReadInvalidArgument } from '../../failures/structured-agent-session-read-refusal'

export type StructuredAgentSessionSubscribeCapabilities =
  Partial<AgentSessionTextAppendCapabilities> & {
    /** This reader shows prompt suggestions, so the host keeps generating them while it reads. */
    promptSuggestions?: 1
  }

type StructuredAgentSessionSubscribeAsk = {
  textAppend: AgentSessionTextAppendCapabilities | null
  capabilities?: StructuredAgentSessionSubscribeCapabilities
}

/** What each open of one read asks the host for, and what earlier opens learned it refuses. */
export function createStructuredAgentSessionSubscribeAsks(asks: {
  textAppend?:
    | Promise<AgentSessionTextAppendCapabilities | null>
    | AgentSessionTextAppendCapabilities
  promptSuggestions?: Promise<boolean> | boolean
}) {
  // A refused append means the two sides disagree; later streams take whole items so it cannot loop.
  let appendsRefused = false
  // A host replaced by an older build refuses the capabilities param; later opens send none.
  let paramRefused = false
  let sent = false
  const settle = (
    textAppend: AgentSessionTextAppendCapabilities | null,
    promptSuggestions: boolean
  ): StructuredAgentSessionSubscribeAsk => {
    const capabilities: StructuredAgentSessionSubscribeCapabilities = {
      ...textAppend,
      ...(promptSuggestions ? { promptSuggestions: 1 } : {})
    }
    sent = Object.keys(capabilities).length > 0
    return { textAppend, ...(sent ? { capabilities } : {}) }
  }
  return {
    refuseAppends: (): void => {
      appendsRefused = true
    },
    /** Called with the failure of the latest open only. */
    refuseOn: (error: unknown): void => {
      paramRefused ||= sent && agentSessionReadInvalidArgument(error)
    },
    /** Answers at once when nothing needs checking, so a local read subscribes in the same turn.
     *  A failed support check asks for nothing; it must not keep the transcript closed. */
    read: (): StructuredAgentSessionSubscribeAsk | Promise<StructuredAgentSessionSubscribeAsk> => {
      const textAppend =
        asks.textAppend && !appendsRefused && !paramRefused ? asks.textAppend : null
      const promptSuggestions = !paramRefused && (asks.promptSuggestions ?? false)
      if (!(textAppend instanceof Promise) && typeof promptSuggestions === 'boolean') {
        return settle(textAppend, promptSuggestions)
      }
      sent = false
      return Promise.all([
        textAppend instanceof Promise ? textAppend.catch(() => null) : textAppend,
        Promise.resolve(promptSuggestions).catch(() => false)
      ]).then(([append, suggestions]) => settle(append, suggestions))
    }
  }
}
