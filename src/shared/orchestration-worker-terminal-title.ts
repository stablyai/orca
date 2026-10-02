const ORCHESTRATION_WORKER_TERMINAL_TITLE_RE = /^worker-task_[A-Za-z0-9_-]+$/

export function isOrchestrationWorkerTerminalTitle(value: string | null | undefined): boolean {
  const title = value?.trim()
  return title ? ORCHESTRATION_WORKER_TERMINAL_TITLE_RE.test(title) : false
}
