import { z } from 'zod'
import { normalizeRepoSourceControlAiOverrides } from '../../source-control/ai/settings/source-control-ai-repo-settings'
import { normalizeRepoBadgeColor } from '../../repo-badge-color'
import { sanitizeRepoIcon } from '../../repo-icon'
import { normalizeGhAccountBinding } from '../../github/accounts/account-binding'
import { normalizeJiraProjectReference } from '../../jira/jira-project-reference'
import {
  normalizeCustomWorktreeVisibilitySources,
  normalizeWorktreeVisibilitySourcePreferences
} from '../../worktree/visibility/visibility-sources'
import { OptionalFiniteNumber, OptionalString } from '../rpc-param-primitives'
import { editorFormatterSchema } from '../../editor-formatter'
import { normalizeDictationTerms } from '../../dictation-dictionary'
import { RepoWorkspaceCleanupPolicyParam } from '../workspace-cleanup/workspace-cleanup-policy-params'

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

// Infer the return type: an explicit ZodObject annotation erases named update fields into an open record.
export function createRepoUpdateSchema<T extends Readonly<Record<string, z.ZodType>>>(
  selectorFields: T
) {
  return z.object({
    ...selectorFields,
    updates: z.object({
      displayName: OptionalString,
      badgeColor: RepoBadgeColor,
      repoIcon: z
        .unknown()
        .transform((value) => sanitizeRepoIcon(value))
        .optional(),
      upstream: RepoUpstream,
      hookSettings: z.unknown().optional(),
      editorFormatter: editorFormatterSchema.optional(),
      worktreeBaseRef: OptionalString,
      worktreeBasePath: OptionalString,
      kind: z.enum(['git', 'folder']).optional(),
      symlinkPaths: z.array(z.string()).optional(),
      dictationTerms: z.unknown().transform(normalizeDictationTerms).optional(),
      issueSourcePreference: z.enum(['auto', 'upstream', 'origin']).optional(),
      defaultJiraProject: z.unknown().optional().transform(normalizeJiraProjectReference),
      ghAccount: z
        .unknown()
        .optional()
        .transform((value) => {
          if (value === undefined) {
            return undefined
          }
          if (value === null) {
            return null
          }
          // Why: malformed bindings must omit the key (IPC deletes); never clear via undefined.
          return normalizeGhAccountBinding(value) ?? undefined
        }),
      forkSyncMode: z.enum(['ask', 'safe-auto', 'off']).optional(),
      agentWorkspaceTrust: z.enum(['pre-trust', 'agent-asks']).optional(),
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
      hiddenAt: z.number().finite().nullable().optional(),
      projectGroupId: OptionalString.nullable().optional(),
      projectGroupOrder: OptionalFiniteNumber.nullable().optional(),
      sourceControlAi: RepoSourceControlAiOverrides,
      workspaceCleanupPolicy: RepoWorkspaceCleanupPolicyParam.optional()
    })
  })
}
