import { normalizeSourceControlAiActionDefaults } from '../../source-control/ai/recipes/source-control-ai-actions'
import { z } from 'zod'
import { lazyZodSchema } from '../../schema/lazy-zod-schema'
import { OptionalTuiAgent } from '../workspaces/worktree-params'
import { isTuiAgent } from '../../agent-launch/catalog/tui-agent-config'
import { FullGitObjectId, WorktreeSelector } from './git-core-params'

export * from './git-core-params'

export const CommitMessageModelCapability = lazyZodSchema(() =>
  z.object({
    id: z.string(),
    label: z.string(),
    thinkingLevels: z.array(z.object({ id: z.string(), label: z.string() })).optional(),
    defaultThinkingLevel: z.string().optional(),
    isDefault: z.boolean().optional()
  })
)

export const CommitMessageAiSettings = lazyZodSchema(() =>
  z.object({
    enabled: z.boolean(),
    agentId: z.string().nullable(),
    selectedModelByAgent: z.record(z.string(), z.string()),
    selectedModelByAgentByHost: z.record(z.string(), z.record(z.string(), z.string())).optional(),
    discoveredModelsByAgent: z.record(z.string(), z.array(CommitMessageModelCapability)).optional(),
    discoveredModelsByAgentByHost: z
      .record(z.string(), z.record(z.string(), z.array(CommitMessageModelCapability)))
      .optional(),
    selectedThinkingByModel: z.record(z.string(), z.string()),
    customPrompt: z.string(),
    customAgentCommand: z.string()
  })
)

export const SourceControlAiSettings = lazyZodSchema(() =>
  CommitMessageAiSettings.omit({ customPrompt: true }).extend({
    discoveredAtByAgentByHost: z.record(z.string(), z.record(z.string(), z.number())).optional(),
    actions: z.unknown().optional().transform(normalizeSourceControlAiActionDefaults),
    instructionsByOperation: z.record(z.string(), z.string()).optional(),
    modelOverridesByOperation: z
      .record(
        z.string(),
        z.object({
          selectedModelByAgent: z.record(z.string(), z.string()).optional(),
          selectedModelByAgentByHost: z
            .record(z.string(), z.record(z.string(), z.string()))
            .optional(),
          selectedThinkingByModel: z.record(z.string(), z.string()).optional()
        })
      )
      .optional(),
    prCreationDefaults: z
      .object({
        draft: z.boolean().optional(),
        useTemplate: z.boolean().optional(),
        generateDetailsOnOpen: z.boolean().optional(),
        openAfterCreate: z.boolean().optional()
      })
      .optional(),
    launchActionDefaults: z.unknown().optional().transform(normalizeSourceControlAiActionDefaults)
  })
)

export const ResolvedSourceControlAiGenerationParams = lazyZodSchema(() =>
  z.object({
    agentId: z.string(),
    model: z.string(),
    usesOrcaDefaultModel: z.boolean().optional(),
    thinkingLevel: z.string().optional(),
    customPrompt: z.string().optional(),
    commandInputTemplate: z.string().optional(),
    agentArgs: z.string().optional(),
    customAgentCommand: z.string().optional(),
    agentCommandOverride: z.string().optional()
  })
)

export const GitGenerateCommitMessage = lazyZodSchema(() =>
  WorktreeSelector.extend({
    commitMessageAi: CommitMessageAiSettings.optional(),
    sourceControlAi: SourceControlAiSettings.optional(),
    sourceControlAiResolvedParams: ResolvedSourceControlAiGenerationParams.optional(),
    agentCmdOverrides: z.record(z.string(), z.string()).optional(),
    // Why: 'blank' (Blank terminal) and a removed agent (an older client's saved Gemini CLI) pick the same fallback as null.
    defaultTuiAgent: z.preprocess(
      (value) =>
        value === 'blank' || (typeof value === 'string' && !isTuiAgent(value)) ? null : value,
      OptionalTuiAgent.nullable()
    ),
    commitMessageDiscoveryHostKey: z.string().optional()
  })
)

export const GitDiscoverCommitMessageModels = lazyZodSchema(() =>
  WorktreeSelector.extend({
    agentId: z.string().min(1, 'Missing agent id'),
    agentCmdOverrides: z.record(z.string(), z.string()).optional()
  })
)

export const GitGeneratePullRequestFields = lazyZodSchema(() =>
  GitGenerateCommitMessage.extend({
    base: z.string().min(1, 'Missing base branch'),
    title: z.string(),
    body: z.string(),
    draft: z.boolean(),
    provider: z
      .enum(['github', 'gitlab', 'bitbucket', 'azure-devops', 'gitea', 'unsupported'])
      .optional(),
    useTemplate: z.boolean().optional()
  })
)

export const GitBulkPaths = lazyZodSchema(() =>
  WorktreeSelector.extend({
    filePaths: z.array(z.string().min(1, 'Missing file path'))
  })
)

// Why: optional so older hosts strip it and stage the listed `filePaths` instead.
export const GitBulkStage = lazyZodSchema(() =>
  GitBulkPaths.extend({
    scope: z.enum(['all', 'tracked']).optional()
  })
)

export const GitPushTargetParam = lazyZodSchema(() =>
  z.object({
    remoteName: z.string(),
    branchName: z.string(),
    remoteUrl: z.string().optional(),
    remoteCreated: z.boolean().optional()
  })
)

export const GitPush = lazyZodSchema(() =>
  WorktreeSelector.extend({
    publish: z.boolean().optional(),
    forceWithLease: z.boolean().optional(),
    pushTarget: GitPushTargetParam.optional()
  })
)

export const GitTargetedRemote = lazyZodSchema(() =>
  WorktreeSelector.extend({
    pushTarget: GitPushTargetParam.optional()
  })
)

export const GitForkSync = lazyZodSchema(() =>
  WorktreeSelector.extend({
    expectedUpstream: z.object({
      owner: z.string().trim().min(1),
      repo: z.string().trim().min(1)
    })
  })
)

export const GitContinueRebase = lazyZodSchema(() =>
  WorktreeSelector.extend({
    action: z.enum(['continue', 'inspect']).optional(),
    // Continue refuses unless the rebase is still at the stop the user was shown.
    expected: z
      .object({
        head: z.string().nullable(),
        step: z.string().nullable(),
        incarnation: z.string().nullable()
      })
      .optional()
  })
)

export const GitRebaseFromBase = lazyZodSchema(() =>
  WorktreeSelector.extend({
    baseRef: z
      .unknown()
      .transform((v) => (typeof v === 'string' ? v : ''))
      .pipe(
        z
          .string()
          .min(1, 'Missing base ref')
          .refine((value) => !value.startsWith('-'), 'Base ref must not start with -')
      )
  })
)

export const GitSwitchBranch = lazyZodSchema(() =>
  WorktreeSelector.extend({
    target: z.object({ kind: z.enum(['local', 'remote', 'new']), name: z.string().min(1) })
  })
)

export const GitCheckout = lazyZodSchema(() =>
  WorktreeSelector.extend({
    detached: z.boolean().optional(),
    branch: z
      .unknown()
      .transform((v) => (typeof v === 'string' ? v : ''))
      .pipe(
        z
          .string()
          .min(1, 'Missing branch')
          // Why: never let a branch arg be parsed as a git flag (arg injection).
          .refine((value) => !value.startsWith('-'), 'Branch must not start with -')
      )
  }).refine(
    (params) => !params.detached || FullGitObjectId.safeParse(params.branch).success,
    'Expected a full git object id for detached checkout'
  )
)

export const GitRemoteFileUrl = lazyZodSchema(() =>
  WorktreeSelector.extend({
    relativePath: z
      .unknown()
      .transform((v) => (typeof v === 'string' ? v : ''))
      .pipe(z.string().min(1, 'Missing relative path')),
    line: z.number().int().min(1),
    endLine: z.number().int().min(1).optional()
  })
)

export const GitRemoteCommitUrl = lazyZodSchema(() =>
  WorktreeSelector.extend({
    sha: z
      .unknown()
      .transform((v) => (typeof v === 'string' ? v : ''))
      .pipe(FullGitObjectId)
  })
)
