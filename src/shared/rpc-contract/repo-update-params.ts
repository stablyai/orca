import { z } from 'zod'
import { normalizeRepoSourceControlAiOverrides } from '../source-control-ai'
import { normalizeRepoBadgeColor } from '../repo-badge-color'
import { sanitizeRepoIcon } from '../repo-icon'
import {
  normalizeCustomWorktreeVisibilitySources,
  normalizeWorktreeVisibilitySourcePreferences
} from '../worktree/visibility-sources'
import { OptionalFiniteNumber, OptionalString } from './rpc-param-primitives'

export const RepoSourceControlAiOverrides = z
  .unknown()
  .optional()
  .transform((value) =>
    value === undefined
      ? undefined
      : value === null
        ? null
        : normalizeRepoSourceControlAiOverrides(value)
  )

export const RepoBadgeColor = z
  .unknown()
  .optional()
  .transform((value) =>
    value === undefined ? undefined : (normalizeRepoBadgeColor(value) ?? undefined)
  )

export const RepoUpstream = z
  .object({
    owner: z.string().min(1),
    repo: z.string().min(1)
  })
  .nullable()
  .optional()

export function createRepoUpdateSchema<T extends z.ZodRawShape>(
  selectorShape: T
): z.ZodObject<T & { updates: z.ZodObject<z.ZodRawShape> }> {
  return z.object({
    ...selectorShape,
    updates: z.object({
      displayName: OptionalString,
      badgeColor: RepoBadgeColor,
      repoIcon: z
        .unknown()
        .transform((value) => sanitizeRepoIcon(value))
        .optional(),
      upstream: RepoUpstream,
      hookSettings: z.unknown().optional(),
      worktreeBaseRef: OptionalString,
      worktreeBasePath: OptionalString,
      kind: z.enum(['git', 'folder']).optional(),
      symlinkPaths: z.array(z.string()).optional(),
      issueSourcePreference: z.enum(['auto', 'upstream', 'origin']).optional(),
      forkSyncMode: z.enum(['ask', 'safe-auto', 'off']).optional(),
      externalWorktreeVisibility: z.enum(['hide', 'show']).nullable().optional(),
      externalWorktreeVisibilityPromptDismissedAt: z.number().finite().optional(),
      externalWorktreeInboxBaselinePaths: z.array(z.string()).optional(),
      importedExternalWorktreePaths: z.array(z.string()).optional(),
      agentWorktreeVisibility: z.enum(['hide', 'show']).nullable().optional(),
      customWorktreeVisibilitySources: z
        .unknown()
        .transform((value) => normalizeCustomWorktreeVisibilitySources(value))
        .optional(),
      worktreeVisibilitySourcePreferences: z
        .unknown()
        .transform((value) => normalizeWorktreeVisibilitySourcePreferences(value))
        .optional(),
      externalWorktreeDiscoverySuppressedAt: z.number().finite().nullable().optional(),
      projectGroupId: OptionalString.nullable().optional(),
      projectGroupOrder: OptionalFiniteNumber,
      sourceControlAi: RepoSourceControlAiOverrides
    })
  }) as z.ZodObject<T & { updates: z.ZodObject<z.ZodRawShape> }>
}
