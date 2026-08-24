export type WorkerStartTaskSource = {
  task?: string
  spec?: string
  taskTitle?: string
  retryOf?: string
}

// Why: the CLI pre-validates so agents fail before a round trip, and the RPC schema enforces the
// same contract for direct callers. One rule set keeps the two layers from reporting it differently.
export function workerStartTaskSourceError(params: WorkerStartTaskSource): string | undefined {
  if (params.task && params.spec) {
    return '--task cannot combine with --spec.'
  }
  if (!params.task && !params.spec) {
    return 'Exactly one of --task or --spec is required.'
  }
  if (params.taskTitle && !params.spec) {
    return '--task-title requires --spec.'
  }
  // Why: retry re-dispatches an existing Task; a just-created --spec Task can never
  // satisfy retry validation, so the combination would only manufacture failures.
  if (params.retryOf && !params.task) {
    return '--retry-of requires --task.'
  }
  return undefined
}
