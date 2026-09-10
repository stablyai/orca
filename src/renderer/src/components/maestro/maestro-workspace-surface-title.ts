export function resolveMaestroWorkspaceSurfaceTitle(
  title: string,
  agentFunctionLabel: string | undefined,
  agentTaskId: string | undefined
): string {
  const functionLabel = agentFunctionLabel?.trim()
  const taskId = agentTaskId?.trim()
  if (!functionLabel) {
    return title
  }
  const normalizedTitle = title.trim()
  const generatedTitles = taskId
    ? new Set([`worker-${taskId}`, `worker-task_${taskId}`, `worker-task-${taskId}`, taskId])
    : new Set<string>()
  const opaqueWorkerTitle = /^(?:worker[-_])?task[_-][a-z0-9_-]+(?:\s*·.*)?$/i.test(normalizedTitle)
  return generatedTitles.has(normalizedTitle) || opaqueWorkerTitle ? functionLabel : title
}
