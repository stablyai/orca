import { z } from 'zod'
import type { CodexCliInstallation } from './codex-cli-installation'
import { openEnum } from './zod-salvage'

export const CODEX_MAINTENANCE_CAPABILITY = 'preflight.codex-maintenance.v2' as const
export const CODEX_INSTALL_COMMAND = 'npm install -g @openai/codex'

export const CodexMaintenanceRequest = z.object({
  operation: z.enum(['status', 'start', 'read']),
  jobId: z.string().min(1).optional(),
  cwd: z.string().min(1).optional()
})

export type CodexMaintenanceParams = z.infer<typeof CodexMaintenanceRequest>
export type CodexMaintenanceJob = {
  id: string
  phase: 'queued' | 'running' | 'completed' | 'unknown'
  output: string
  exitCode: number | null
  error: string | null
  termination?: 'live' | 'unverifiable' | 'exited'
}
export type CodexMaintenanceState = {
  installation: CodexCliInstallation
  /** True only when Codex is missing and the host can run the install now. */
  canRun: boolean
  job: CodexMaintenanceJob | null
  currentJob?: Pick<CodexMaintenanceJob, 'id' | 'phase'> | null
  evidence?: { expiresAt: number; configurationId: string; observedAt?: number }
}

const CodexMaintenanceJobSchema = z
  .object({
    id: z.string(),
    phase: openEnum(['queued', 'running', 'completed', 'unknown'], 'unknown'),
    output: z.string(),
    exitCode: z.number().nullable(),
    error: z.string().nullable(),
    termination: openEnum(['live', 'unverifiable', 'exited'], 'unverifiable').optional()
  })
  .nullable()

export const CodexMaintenanceStateSchema = z.object({
  installation: z.object({
    status: openEnum(['missing', 'unsupported', 'ready', 'unknown'], 'unknown'),
    version: z.string().nullable(),
    minimumVersion: z.string()
  }),
  canRun: z.boolean(),
  job: CodexMaintenanceJobSchema,
  currentJob: z
    .object({
      id: z.string(),
      phase: openEnum(['queued', 'running', 'completed', 'unknown'], 'unknown')
    })
    .nullable()
    .optional(),
  evidence: z
    .object({
      expiresAt: z.number().finite(),
      configurationId: z.string().min(1),
      observedAt: z.number().finite().optional()
    })
    .optional()
})
