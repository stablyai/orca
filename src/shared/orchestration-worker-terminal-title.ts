// The title a dispatched worker terminal is created with, before its agent
// publishes one of its own. It identifies the pane for `terminal ls` and logs;
// it is an infrastructure handle, not a conversation name, so name resolution
// must recognise and reject it (agent-row-conversation-name.ts).
const ORCHESTRATION_WORKER_TERMINAL_TITLE_RE = /^worker-task_[A-Za-z0-9_-]+$/

export function buildOrchestrationWorkerTerminalTitle(taskId: string): string {
  return `worker-${taskId}`
}

/**
 * Whether `title` is the placeholder above. Matched by shape rather than by a
 * known task id: a paired remote host mints its own ids and may be older than
 * this client, so the client can never enumerate the ids it will be sent.
 */
export function isOrchestrationWorkerTerminalTitle(title: string): boolean {
  return ORCHESTRATION_WORKER_TERMINAL_TITLE_RE.test(title)
}
