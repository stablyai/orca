import { basename, dirname, join } from 'node:path'

// Why a strict id: it becomes a file name, so it must never reach outside the session folder.
const AGENT_ID = /^[\w-]{1,64}$/

/** Where Claude writes a helper agent's own transcript: `<session>/subagents/agent-<id>.jsonl`, beside
 *  the session's. A helper's tool calls are recorded only there. Null for an id that is not a plain name. */
export function claudeSubagentTranscriptPath(
  sessionTranscriptPath: string,
  agentId: string
): string | null {
  return AGENT_ID.test(agentId)
    ? join(
        dirname(sessionTranscriptPath),
        basename(sessionTranscriptPath, '.jsonl'),
        'subagents',
        `agent-${agentId}.jsonl`
      )
    : null
}
