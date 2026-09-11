import { z } from 'zod'
import { isTaskProvider } from '../task-providers'
import type { TaskProvider } from '../task-providers'
import { isTuiAgent } from '../tui-agent-config'
import { normalizeDisabledTuiAgents } from '../tui-agent-selection'
import {
  normalizeTuiAgentArgsRecord,
  normalizeTuiAgentEnvRecord
} from '../tui-agent-launch-defaults'
import { normalizePRBotAuthorOverrides } from '../pr-bot-author-overrides'
import { WorktreeVisibilityDefaultsUpdate } from './worktree-visibility-defaults-params'

export const TaskProviderParam = z.custom<TaskProvider>(isTaskProvider, {
  message: 'Unknown task provider'
})

export const PRBotAuthorOverrideUpdate = z
  .object({ author: z.string(), isBot: z.boolean() })
  .strict()

export const NativeChatSessionOptionPickBase = {
  modelId: z.string().trim().min(1).max(512),
  adoptModelAsLaunchDefault: z.boolean().optional()
}

export const NativeChatSessionOptionPick = z.union([
  z
    .object({
      ...NativeChatSessionOptionPickBase,
      optionId: z.enum(['model', 'effort']),
      value: z.string().trim().min(1).max(512)
    })
    .strict(),
  z
    .object({
      ...NativeChatSessionOptionPickBase,
      optionId: z.enum(['fastMode', 'thinking']),
      value: z.boolean()
    })
    .strict()
])

export const NativeChatSessionOptionsMutation = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('apply-picks'),
      agent: z.enum(['claude', 'codex', 'gemini', 'cursor', 'grok']),
      picks: z.array(NativeChatSessionOptionPick).min(1).max(8)
    })
    .strict(),
  z
    .object({
      type: z.literal('clear-model-if-missing'),
      agent: z.enum(['claude', 'codex', 'gemini', 'cursor', 'grok']),
      availableModelIds: z.array(z.string().trim().min(1).max(512)).min(1).max(256)
    })
    .strict()
])

export const GitHubProjectRef = z
  .object({
    owner: z.string(),
    ownerType: z.enum(['organization', 'user']),
    number: z.number().int(),
    host: z.string().optional()
  })
  .strict()

export const GitHubProjectSettings = z
  .object({
    pinned: z.array(GitHubProjectRef),
    recent: z.array(
      GitHubProjectRef.extend({
        lastOpenedAt: z.string()
      }).strict()
    ),
    lastViewByProject: z.record(z.string(), z.object({ viewId: z.string() }).strict()),
    activeProject: GitHubProjectRef.nullable()
  })
  .strict()

export const SettingsUpdate = z
  .object({
    worktreeVisibilityDefaults: WorktreeVisibilityDefaultsUpdate.optional(),
    defaultTuiAgent: z
      .unknown()
      .transform((value) =>
        value === null || value === 'blank' || isTuiAgent(value) ? value : undefined
      )
      .optional(),
    disabledTuiAgents: z
      .unknown()
      .transform((value) => normalizeDisabledTuiAgents(value))
      .optional(),
    agentDefaultArgs: z
      .unknown()
      .transform((value) => normalizeTuiAgentArgsRecord(value))
      .optional(),
    agentDefaultEnv: z
      .unknown()
      .transform((value) => normalizeTuiAgentEnvRecord(value))
      .optional(),
    defaultTaskSource: TaskProviderParam.optional(),
    visibleTaskProviders: z.array(TaskProviderParam).optional(),
    defaultTaskViewPreset: z
      .enum(['issues', 'my-issues', 'prs', 'my-prs', 'review', 'all'])
      .optional(),
    experimentalNewWorktreeCardStyle: z.boolean().optional(),
    // The only lever a headless host has for structured-chat admission: it ships no settings UI,
    // so without this key a fresh `orca serve` or peer host refuses the surface forever.
    experimentalStructuredNativeChat: z.boolean().optional(),
    agentStatusHooksEnabled: z.boolean().optional(),
    defaultRepoSelection: z.array(z.string()).nullable().optional(),
    defaultLinearTeamSelection: z.array(z.string()).nullable().optional(),
    compactWorktreeCards: z.boolean().optional(),
    minimaxGroupId: z.string().optional(),
    minimaxUsageModels: z.string().optional(),
    minimaxEndpoint: z.enum(['overseas', 'cn']).optional(),
    githubProjects: GitHubProjectSettings.optional(),
    prBotAuthorOverrides: z
      .unknown()
      .transform((value) => normalizePRBotAuthorOverrides(value))
      .optional()
  })
  .strict()
  .default({})
