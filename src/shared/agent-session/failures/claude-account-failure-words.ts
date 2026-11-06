import type { AgentSessionFailureSay } from './agent-session-failure-copy'

type PlainSentence = (
  context: unknown,
  fact: unknown,
  surface: unknown,
  say: AgentSessionFailureSay
) => string

function plain(id: Parameters<AgentSessionFailureSay>[0]): PlainSentence {
  return (_context, _fact, _surface, say) => say(id)
}

/** A launch on a chosen Claude account that could not start: nothing to fill in but the kind. */
export const CLAUDE_ACCOUNT_FAILURE_SENTENCES = {
  claudeAccountFolderMissing: plain('claudeAccountFolderMissing'),
  claudeAccountSetupFailed: plain('claudeAccountSetupFailed'),
  claudeAccountUnknown: plain('claudeAccountUnknown'),
  claudeAccountWslUnsupported: plain('claudeAccountWslUnsupported')
}
