import { z } from 'zod'

export const ClientUiWorkspaceFilterFields = {
  hideDefaultBranchWorkspace: z.boolean().optional(),
  hideAutomationGeneratedWorkspaces: z.boolean().optional(),
  hideCliCreatedWorkspaces: z.boolean().optional(),
  hideDetachedHeadWorkspaces: z.boolean().optional(),
  hideWorkspacesFromOtherDevices: z.boolean().optional(),
  alwaysShowDefaultBranchWorkspace: z.boolean().optional(),
  filterAgentIds: z.array(z.unknown()).nullable().optional(),
  // Why: leftover singular/harness keys from older paired clients must not reject ui.set.
  filterAgentId: z.unknown().nullable().optional(),
  filterHarnessId: z.enum(['cc', 'codex']).nullable().optional(),
  filterRepoIds: z.array(z.string()).optional()
}
