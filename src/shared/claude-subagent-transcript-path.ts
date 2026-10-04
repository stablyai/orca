// Where Claude CLI writes a Task subagent's own transcript, beside its parent's:
// `<dir>/<session>.jsonl` → `<dir>/<session>/subagents/agent-<agentId>.jsonl`.

export const CLAUDE_SUBAGENT_DIR_NAME = 'subagents'
export const CLAUDE_SUBAGENT_TRANSCRIPT_PREFIX = 'agent-'

// Hook agent ids are short hex; anything else must not be joined into a path.
const CLAUDE_SUBAGENT_ID = /^[A-Za-z0-9_-]{1,128}$/

/** The subagent's transcript path, in the parent path's own separator style (POSIX, WSL or
 *  Windows), or null when the id is not one Claude would put in a file name. */
export function claudeSubagentTranscriptPath(
  parentTranscriptPath: string,
  agentId: string
): string | null {
  if (!CLAUDE_SUBAGENT_ID.test(agentId)) {
    return null
  }
  const separatorIndex = Math.max(
    parentTranscriptPath.lastIndexOf('/'),
    parentTranscriptPath.lastIndexOf('\\')
  )
  if (separatorIndex < 0) {
    return null
  }
  const separator = parentTranscriptPath[separatorIndex]
  const fileName = parentTranscriptPath.slice(separatorIndex + 1)
  const extensionIndex = fileName.lastIndexOf('.')
  const stem = extensionIndex > 0 ? fileName.slice(0, extensionIndex) : fileName
  if (stem === '') {
    return null
  }
  return [
    parentTranscriptPath.slice(0, separatorIndex),
    stem,
    CLAUDE_SUBAGENT_DIR_NAME,
    `${CLAUDE_SUBAGENT_TRANSCRIPT_PREFIX}${agentId}.jsonl`
  ].join(separator)
}
