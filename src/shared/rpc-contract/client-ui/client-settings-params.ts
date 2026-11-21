import * as z from 'zod'
import { isTaskProvider } from '../../work-items/task-providers'
import type { TaskProvider } from '../../work-items/task-providers'
import { isTuiAgent } from '../../agent-launch/catalog/tui-agent-config'
import { normalizeDisabledTuiAgents } from '../../agent-launch/catalog/tui-agent-selection'
import {
  normalizeTuiAgentArgsRecord,
  normalizeTuiAgentEnvRecord
} from '../../agent-launch/choices/tui-agent-launch-defaults'
import { MACHINE_NAME_MAX_LENGTH } from '../../remote-runtime/host-metadata/machine-name'
import { normalizePRBotAuthorOverrides } from '../../source-control/review-comments/pr-bot-author-overrides'
import { normalizeNewTabMenuLayout } from '../../new-tab-menu/new-tab-menu-layout'
import { WorktreeVisibilityDefaultsUpdate } from '../workspaces/worktree-visibility-defaults-params'
import { WorkspaceCleanupRulesParam } from '../workspace-cleanup/workspace-cleanup-policy-params'
import { AGENT_CHAT_PERMISSION_MODES } from '../../agent-launch/permissions/agent-chat-permission-mode'
import { SUPPORTED_UI_LOCALES } from '../../i18n/ui-locale'
import { PR_AUTO_REFRESH_CADENCES } from '../../source-control/hosted-review/review-refresh-policy'
import { HOST_OWNED_SETTING_UPDATE_SHAPE } from '../../settings/host-owned-settings'

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
      optionId: z.enum(['model', 'effort', 'serviceTier']),
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

// Any agent Orca launches: picks are keyed by agent id, and every native chat agent remembers them.
const NativeChatSessionOptionAgent = z.string().refine(isTuiAgent, { message: 'Unknown agent' })

export const NativeChatSessionOptionsMutation = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('apply-picks'),
      agent: NativeChatSessionOptionAgent,
      picks: z.array(NativeChatSessionOptionPick).min(1).max(8),
      /** The chat the picks were made in; a bot's conversation keeps them on the bot. Older clients omit it. */
      sessionId: z.string().trim().min(1).max(512).optional()
    })
    .strict(),
  z
    .object({
      type: z.literal('clear-model-if-missing'),
      agent: NativeChatSessionOptionAgent,
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

const HostNotificationSettingsUpdate = z
  .object({
    enabled: z.boolean().optional(),
    agentTaskComplete: z.boolean().optional(),
    agentNeedsInput: z.boolean().optional(),
    terminalBell: z.boolean().optional()
  })
  .strict()

export const SettingsUpdate = z
  .object({
    ...HOST_OWNED_SETTING_UPDATE_SHAPE,
    workspaceTitleLanguage: z.enum(['branch', 'ui', ...SUPPORTED_UI_LOCALES]).optional(),
    machineName: z.string().trim().max(MACHINE_NAME_MAX_LENGTH).optional(),
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
    worktreeCardDetailsRow: z.boolean().optional(),
    /** The host-side switch for bots, so a headless server can turn them on. */
    botsEnabled: z.boolean().optional(),
    agentStatusHooksEnabled: z.boolean().optional(),
    claudeSubagentNavigationEnabled: z.boolean().optional(),
    defaultRepoSelection: z.array(z.string()).nullable().optional(),
    defaultLinearTeamSelection: z.array(z.string()).nullable().optional(),
    compactWorktreeCards: z.boolean().optional(),
    minimaxGroupId: z.string().optional(),
    minimaxUsageModels: z.string().optional(),
    minimaxEndpoint: z.enum(['overseas', 'cn']).optional(),
    zcodePlanSite: z.enum(['zai', 'bigmodel']).optional(),
    githubProjects: GitHubProjectSettings.optional(),
    prBotAuthorOverrides: z
      .unknown()
      .transform((value) => normalizePRBotAuthorOverrides(value))
      .optional(),
    nativeChatResumeWorkOnRestart: z.boolean().optional(),
    nativeChatPermissionMode: z.enum(AGENT_CHAT_PERMISSION_MODES).optional(),
    nativeChatQueueFollowUps: z.boolean().optional(),
    nativeChatCiResultLines: z.boolean().optional(),
    /** This host's own notification switches; see HOST_NOTIFICATION_SETTINGS_RUNTIME_CAPABILITY. */
    hostNotifications: HostNotificationSettingsUpdate.optional(),
    workspaceCleanupPolicy: WorkspaceCleanupRulesParam.optional(),
    prAutoRefresh: z.enum(PR_AUTO_REFRESH_CADENCES).optional(),
    newTabMenuLayout: z.unknown().transform(normalizeNewTabMenuLayout).optional(),
    floatingTerminalNewTabMenuLayout: z.unknown().transform(normalizeNewTabMenuLayout).optional()
  })
  .strict()
  .default({})
