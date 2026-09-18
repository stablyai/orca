import type { CodexSubagentTranscriptState } from './codex-subagent-transcript'

const SANDBOX_APPROVAL_TOOLS = new Set([
  'Bash',
  'exec_command',
  'shell',
  'shell_command',
  'apply_patch'
])

export function isCodexTranscriptAutoApprovalReview(
  state: CodexSubagentTranscriptState | undefined,
  transcriptPath: string | undefined,
  turnId: string | undefined,
  agentId: string | undefined,
  toolName: string | undefined
): boolean {
  // App-level approvals can still require a person even when sandbox approvals use auto-review.
  if (!state || !transcriptPath || !turnId || !toolName || !SANDBOX_APPROVAL_TOOLS.has(toolName)) {
    return false
  }
  const cursor = agentId ? state.subagents.get(agentId) : state.parent
  return (
    cursor?.filePath === transcriptPath.trim() &&
    cursor.turnContext?.turnId === turnId &&
    cursor.turnContext.autoReview
  )
}
