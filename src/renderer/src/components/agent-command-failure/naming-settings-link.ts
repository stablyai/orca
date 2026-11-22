import { useAppStore } from '@/store/index'
import { isWebClientLocation } from '@/app-shell/platform/web-client-location'
import type { SettingsNavigationTarget } from '@/components/settings/navigation/settings-navigation-types'
import {
  SOURCE_CONTROL_AI_SETTINGS_SECTION_ID,
  getSourceControlAiActionRecipeSectionId
} from '@/components/settings/source-control/source-control-ai-settings-targets'
import {
  getRepositorySourceControlAiActionRecipeSectionId,
  getRepositorySourceControlAiCustomCommandSectionId
} from '@/components/settings/repository/repository-settings-targets'
import { CHAT_NAME_AGENT_SECTION_ID } from '@/components/settings/chat/chat-naming-search'
import {
  LOCAL_EXECUTION_HOST_ID,
  getRepoExecutionHostId,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host/execution-host'
import { isFolderRepo } from '../../../../shared/repository/repo-kind'
import type { Repo } from '../../../../shared/repository/repo-types'
import type { GlobalSettings } from '../../../../shared/settings/global-settings-types'
import { normalizeSourceControlAiSettings } from '../../../../shared/source-control/ai/settings/source-control-ai-settings'
import { normalizeRepoSourceControlAiOverrides } from '../../../../shared/source-control/ai/settings/source-control-ai-repo-settings'
import { readSourceControlAiModelChoiceForHost } from '../../../../shared/source-control/ai/settings/source-control-ai-model-selection'
import { summarizeReposOverridingActionRecipe } from '../../../../shared/source-control/ai/source-control-launch-agent-selection'
import { resolveActionRecipeForTextOperation } from '../../../../shared/source-control/ai/source-control-ai-operation-policy'
import { hasActionAgentRecipe } from '../../../../shared/source-control/ai/recipes/source-control-ai-command-template'
import {
  isCustomAgentId,
  resolveCommitMessageAgentChoice
} from '../../../../shared/source-control/ai/generation/commit-message-agent-spec'
import { getCommitMessageModelDiscoveryHostKey } from '../../../../shared/source-control/ai/generation/commit-message-host-key'
import { TEXT_GENERATION_FAILURE_COPY } from '../../../../shared/text-generation/text-generation-failure-copy'
import {
  BRANCH_NAME_ENVIRONMENT_FAILED_HEADLINE,
  BRANCH_PUBLISHED_CHECK_FAILED_HEADLINE,
  WORKSPACE_NAME_ENVIRONMENT_FAILED_HEADLINE
} from '../../../../shared/worktree/branch-auto-rename-failure-headlines'
import { getRepoIdFromWorktreeId } from '../../../../shared/worktree/id'

// Failures no naming setting can fix: changing the agent would not help, so the link would distract from retrying.
const TRANSIENT_FAILURE_PREFIXES = [
  TEXT_GENERATION_FAILURE_COPY.timedOut.slice(
    0,
    TEXT_GENERATION_FAILURE_COPY.timedOut.indexOf('{{')
  ),
  BRANCH_PUBLISHED_CHECK_FAILED_HEADLINE,
  BRANCH_NAME_ENVIRONMENT_FAILED_HEADLINE,
  WORKSPACE_NAME_ENVIRONMENT_FAILED_HEADLINE
]

/** Unknown or older messages count as fixable: the link is harmless where it can't help. */
export function isTransientNamingFailure(error: string): boolean {
  const headline = error.trimStart()
  return TRANSIENT_FAILURE_PREFIXES.some((prefix) => headline.startsWith(prefix))
}

/**
 * This app names local and SSH workspaces with its own settings. A paired runtime names its
 * workspaces with its settings, which these panes don't edit; the web client has no Settings.
 */
export function canOpenNamingSettings(executionHostId: string | null | undefined): boolean {
  return !isWebClientLocation() && parseExecutionHostId(executionHostId)?.kind !== 'runtime'
}

// Same shape generation accepts, so callers and tests can pass partial settings.
type BranchNamingSettings = Partial<
  Pick<
    GlobalSettings,
    'sourceControlAi' | 'commitMessageAi' | 'defaultTuiAgent' | 'disabledTuiAgents'
  >
>

type BranchNamingRepo = Pick<
  Repo,
  'id' | 'displayName' | 'kind' | 'sourceControlAi' | 'connectionId' | 'executionHostId'
>

/** Which of the repo's own settings decide this repo's branch-name run, in generation's order. */
function repoBranchNamingOwner(
  repo: BranchNamingRepo,
  settings: BranchNamingSettings | null
): 'custom-command' | 'recipe' | null {
  const repoOverrides = normalizeRepoSourceControlAiOverrides(repo.sourceControlAi)
  if (!repoOverrides) {
    return null
  }
  const source = normalizeSourceControlAiSettings(
    settings?.sourceControlAi,
    settings?.commitMessageAi
  )
  const recipe = resolveActionRecipeForTextOperation(source, repoOverrides, 'branchName')
  const agent = resolveCommitMessageAgentChoice(
    hasActionAgentRecipe(recipe) ? recipe.agentId : source.agentId,
    settings?.defaultTuiAgent,
    settings?.disabledTuiAgents
  )
  // Generation prefers the repo's custom command over the global one (operation resolution).
  if (isCustomAgentId(agent) && repoOverrides.customAgentCommand) {
    return 'custom-command'
  }
  const recipeOverridden = summarizeReposOverridingActionRecipe({
    repos: [repo],
    actionId: 'branchName'
  }).count
  // A repo model pick wins over the global one for the agent that runs (model selection).
  const modelOverridden =
    agent !== null &&
    !isCustomAgentId(agent) &&
    readSourceControlAiModelChoiceForHost(
      repoOverrides.modelOverridesByOperation?.branchName,
      getCommitMessageModelDiscoveryHostKey(null),
      agent
    ) !== undefined
  const instructionsOverridden = repoOverrides.instructionsByOperation?.branchName !== undefined
  return recipeOverridden || modelOverridden || instructionsOverridden ? 'recipe' : null
}

/** Where the setting that governs this workspace's branch-name run is edited, following how naming resolves it. */
export function branchNamingSettingsTarget(input: {
  worktreeId: string
  /** The workspace's host; same-id repos on other hosts carry other settings. */
  executionHostId: ExecutionHostId | null | undefined
  settings: BranchNamingSettings | null
  repos: readonly BranchNamingRepo[]
}): SettingsNavigationTarget {
  const repoId = getRepoIdFromWorktreeId(input.worktreeId)
  const hostId = input.executionHostId ?? LOCAL_EXECUTION_HOST_ID
  // Folder workspaces name with the global recipe; only git repos have their own rows.
  const repo = input.repos.find(
    (candidate) =>
      candidate.id === repoId &&
      getRepoExecutionHostId(candidate) === hostId &&
      !isFolderRepo(candidate)
  )
  const owner = repo ? repoBranchNamingOwner(repo, input.settings) : null
  if (repo && owner) {
    return {
      pane: 'repo',
      repoId: repo.id,
      hostId,
      sectionId:
        owner === 'custom-command'
          ? getRepositorySourceControlAiCustomCommandSectionId(repo.id)
          : getRepositorySourceControlAiActionRecipeSectionId(repo.id, 'branchName')
    }
  }
  const recipesShown = normalizeSourceControlAiSettings(
    input.settings?.sourceControlAi,
    input.settings?.commitMessageAi
  ).enabled
  return {
    pane: 'git',
    repoId: null,
    sectionId: recipesShown
      ? getSourceControlAiActionRecipeSectionId('branchName')
      : SOURCE_CONTROL_AI_SETTINGS_SECTION_ID
  }
}

/** The chat-name agent row (its Advanced disclosure opens on reveal); the group while naming is off. */
export function chatNamingSettingsTarget(
  settings: Pick<GlobalSettings, 'nativeChatAutoName'> | null
): SettingsNavigationTarget {
  return {
    pane: 'chat',
    repoId: null,
    sectionId: settings?.nativeChatAutoName === false ? 'chat-names' : CHAT_NAME_AGENT_SECTION_ID
  }
}

/**
 * Opens Settings on the setting; Settings moves focus to its first control once revealed, so
 * keyboard users land where the fix is. Callers keep the closing dialog from restoring focus.
 */
export function openNamingSettings(target: SettingsNavigationTarget): void {
  const store = useAppStore.getState()
  store.openSettingsPage()
  store.openSettingsTarget({ ...target, focusFirstControl: true })
}
