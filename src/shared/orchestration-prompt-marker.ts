const ORCHESTRATION_PROMPT_MARKER_PREFIX = '[orca-dispatch-prompt:'

export function buildOrchestrationPromptMarker(taskId: string, dispatchId: string): string {
  return `${ORCHESTRATION_PROMPT_MARKER_PREFIX}${taskId}:${dispatchId}]`
}
