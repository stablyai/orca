import { z } from 'zod'
export const agentSessionExecutionReportSchema = z
  .object({
    status: z.enum(['succeeded', 'failed', 'needs_context']),
    summary: z.string().trim().min(1).max(8192)
  })
  .strict()
export type AgentSessionExecutionReport = z.infer<typeof agentSessionExecutionReportSchema>
export type AgentSessionExecutionReporter = (report: AgentSessionExecutionReport) => Promise<void>
export type AgentSessionExecutionReporterFactory = (binding: {
  sessionId: string
  fence: number
  spawnToken: string
  currentGeneration: () => string | null
}) => AgentSessionExecutionReporter
