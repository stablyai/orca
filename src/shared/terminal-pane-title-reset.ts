// CLIs can leave agent names/spinners after exit; replace them only when the agent is known gone.

import { resolveTerminalTitlePolicyAgentType } from './terminal-title-agent-type'

export function neutralTerminalTitle(defaultTitle: string | null | undefined): string {
  return defaultTitle?.trim() || 'Terminal'
}

/** A confirmed return to a shell resets an agent-named title; user and shell titles stay. */
export function titleAfterConfirmedShell(
  title: string | null | undefined,
  defaultTitle: string | null | undefined
): string | null {
  if (!title || resolveTerminalTitlePolicyAgentType(title) === null) {
    return null
  }
  return neutralTerminalTitle(defaultTitle)
}

/** An inferred interrupt resets whatever title the pane shows, typically a working spinner. */
export function titleAfterInferredInterrupt(
  title: string | null | undefined,
  defaultTitle: string | null | undefined
): string | null {
  return title ? neutralTerminalTitle(defaultTitle) : null
}
