import * as z from 'zod'

const text = z.string().trim().min(1).max(8_192)

export const agentSessionAdvisoryReportSchema = z
  .object({
    status: z.enum(['recommendation', 'inconclusive', 'conflict', 'timeout', 'error']),
    recommendation: text.optional(),
    evidence: z.array(z.string().trim().min(1).max(2_048)).max(16).optional(),
    uncertainty: text.optional(),
    next_test: text.optional()
  })
  .strict()
  .refine(
    (report) =>
      report.status !== 'recommendation' ||
      Boolean(
        report.recommendation && report.evidence?.length && report.uncertainty && report.next_test
      )
  )
  .refine((report) => new TextEncoder().encode(JSON.stringify(report)).byteLength <= 32_768)

export type AgentSessionAdvisoryReport = z.infer<typeof agentSessionAdvisoryReportSchema>
export type AgentSessionAdvisoryReporter = (report: AgentSessionAdvisoryReport) => Promise<void>
export type AgentSessionAdvisoryReporterFactory = (binding: {
  sessionId: string
  fence: number
  spawnToken: string
  currentGeneration: () => string | null
}) => AgentSessionAdvisoryReporter
