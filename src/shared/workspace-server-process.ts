import { z } from 'zod'

export const WORKSPACE_SERVER_OUTPUT_SOURCE_PREFIX = 'workspace-server:'
export const SERVER_LOG_MAX_LINES = 500
export const SERVER_LOG_MAX_CHARS = 65536
export const WorkspaceServerLogLine = z.object({
  seq: z.number(),
  time: z.number(),
  source: z.enum(['stdout', 'stderr', 'system']),
  level: z.enum(['info', 'warning', 'error']),
  text: z.string()
})
export type WorkspaceServerLogLine = z.infer<typeof WorkspaceServerLogLine>
export const WorkspaceServerInfo = z.object({
  id: z.string(),
  worktreeId: z.string(),
  port: z.number(),
  name: z.string(),
  status: z.enum(['starting', 'running', 'stopping', 'stopped', 'error']),
  active: z.boolean(),
  pid: z.number().optional(),
  exitCode: z.number().nullable(),
  errorCount: z.number(),
  startedAt: z.number()
})
export type WorkspaceServerInfo = z.infer<typeof WorkspaceServerInfo>
export const WorkspaceServerSnapshot = WorkspaceServerInfo.extend({
  logs: z.array(WorkspaceServerLogLine)
})
export type WorkspaceServerSnapshot = z.infer<typeof WorkspaceServerSnapshot>
export const WorkspaceServerFrame = z.discriminatedUnion('type', [
  z.object({ type: z.literal('snapshot'), runs: z.array(WorkspaceServerSnapshot) }),
  z.object({
    type: z.literal('update'),
    info: WorkspaceServerInfo,
    lines: z.array(WorkspaceServerLogLine),
    reset: z.boolean()
  })
])
export type WorkspaceServerFrame = z.infer<typeof WorkspaceServerFrame>

export function trimServerLogs(lines: WorkspaceServerLogLine[]): WorkspaceServerLogLine[] {
  let size = 0
  let start = lines.length
  while (start > 0 && lines.length - start < SERVER_LOG_MAX_LINES) {
    const length = lines[start - 1]!.text.length
    if (size + length > SERVER_LOG_MAX_CHARS) {
      break
    }
    size += length
    start -= 1
  }
  return lines.slice(start)
}

export function serverLogLevel(text: string): WorkspaceServerLogLine['level'] {
  if (
    /^\s*(?:error|fatal|panic)(?:[\s:])/i.test(text) ||
    /(?:^|[\s[(])(?:ERROR|FATAL|PANIC)(?=[\s\]:)])/.test(text) ||
    /(?:^|[\s:])(?:[\w.]*Error|[\w.]*Exception):|Exception in thread/.test(text) ||
    /"(?:level|severity)"\s*:\s*"(?:error|fatal)"/i.test(text)
  ) {
    return 'error'
  }
  return /\bWARN(?:ING)?\b/i.test(text) ? 'warning' : 'info'
}
