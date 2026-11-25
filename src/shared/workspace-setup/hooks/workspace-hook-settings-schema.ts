import { z } from 'zod'

export const WorkspaceHookSettingsSchema = z.object({
  mode: z.enum(['auto', 'override']),
  setupRunPolicy: z.enum(['ask', 'run-by-default', 'skip-by-default']).optional(),
  setupAgentStartupPolicy: z.enum(['start-immediately', 'wait-for-setup']).optional(),
  commandSourcePolicy: z.enum(['shared-only', 'local-only', 'run-both']).optional(),
  scripts: z.object({ setup: z.string(), archive: z.string() })
})
