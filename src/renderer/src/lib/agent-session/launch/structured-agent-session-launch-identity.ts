import type { TuiAgent } from '../../../../../shared/tui-agent'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../../shared/execution-host'
import type { StructuredAgentLaunchOptions } from '../../structured-agent-session-launch-callers'

// Key by agent for concurrent Claude/Codex starts, and conversation so resumes never join unrelated blank launches.
export function structuredLaunchIdentity(
  worktreeId: string,
  agent: TuiAgent,
  scope: Pick<StructuredAgentLaunchOptions, 'resumeFrom' | 'executionHostId' | 'sideChatOf'> = {}
): string {
  const { resumeFrom, executionHostId = LOCAL_EXECUTION_HOST_ID } = scope
  // A conversation id names a transcript on one host; never join a resume running on another.
  return scope.sideChatOf
    ? `${agent}:${worktreeId}:side:${executionHostId}:${scope.sideChatOf}`
    : resumeFrom
      ? `${agent}:${worktreeId}:resume:${executionHostId}:${resumeFrom.providerSessionId}`
      : `${agent}:${worktreeId}`
}
