import { z } from 'zod'
import {
  WORKSPACE_CLEANUP_INACTIVE_ACTIONS,
  WORKSPACE_CLEANUP_KEEP_WHEN_VALUES,
  WORKSPACE_CLEANUP_POLICY_MAX_DAYS,
  WORKSPACE_CLEANUP_POLICY_MIN_DAYS
} from '../workspace-cleanup/workspace-cleanup-policy'

const CleanupDays = z
  .number()
  .int()
  .min(WORKSPACE_CLEANUP_POLICY_MIN_DAYS)
  .max(WORKSPACE_CLEANUP_POLICY_MAX_DAYS)

// Whole rule sets only: a client writes back every rule it read.
export const WorkspaceCleanupRulesParam = z
  .object({
    merged: z.object({ enabled: z.boolean() }).strict(),
    unchanged: z.object({ enabled: z.boolean(), afterDays: CleanupDays }).strict(),
    inactive: z
      .object({
        enabled: z.boolean(),
        afterDays: CleanupDays,
        action: z.enum(WORKSPACE_CLEANUP_INACTIVE_ACTIONS)
      })
      .strict(),
    automationRuns: z.object({ enabled: z.boolean() }).strict(),
    orchestrationWorkers: z.object({ enabled: z.boolean() }).strict(),
    keepWhen: z.enum(WORKSPACE_CLEANUP_KEEP_WHEN_VALUES)
  })
  .strict()

/** Null clears the project override so it inherits the host's rules again. */
export const RepoWorkspaceCleanupPolicyParam = z
  .discriminatedUnion('mode', [
    z.object({ mode: z.literal('off') }).strict(),
    z.object({ mode: z.literal('custom'), rules: WorkspaceCleanupRulesParam }).strict()
  ])
  .nullable()
