/** Claude tells a parent agent about a background task with a user turn that starts with this tag. */
export const CLAUDE_TASK_NOTIFICATION_MARKER = '<task-notification>'
const TASK_ID_PATTERN = /<task-id>([^<]+)<\/task-id>/
const TASK_STATUS_PATTERN = /<status>([a-z_]+)<\/status>/

/** Claude 2.1.287 Monitor events reuse task tags before completion. Read status only before summary; output may contain its own status tag. */
export function readClaudeTaskNotification(
  text: string
): { taskId: string; status?: string } | null {
  if (!text.startsWith(CLAUDE_TASK_NOTIFICATION_MARKER)) {
    return null
  }
  const taskId = TASK_ID_PATTERN.exec(text)?.[1]?.trim()
  if (!taskId) {
    return null
  }
  const summaryAt = text.indexOf('<summary>')
  const status = TASK_STATUS_PATTERN.exec(summaryAt === -1 ? text : text.slice(0, summaryAt))?.[1]
  return { taskId, ...(status ? { status } : {}) }
}
