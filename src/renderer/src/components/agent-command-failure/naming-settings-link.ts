import { useAppStore } from '@/store/index'
import { isWebClientLocation } from '@/app-shell/platform/web-client-location'
import type { SettingsNavigationTarget } from '@/components/settings/navigation/settings-navigation-types'
import {
  SOURCE_CONTROL_AI_SETTINGS_SECTION_ID,
  getSourceControlAiActionRecipeSectionId
} from '@/components/settings/source-control/source-control-ai-settings-targets'
import { getRepositorySourceControlAiActionRecipeSectionId } from '@/components/settings/repository/repository-settings-targets'
import { CHAT_NAME_AGENT_SECTION_ID } from '@/components/settings/chat/chat-naming-search'
import { parseExecutionHostId } from '../../../../shared/execution-host/execution-host'
import { isFolderRepo } from '../../../../shared/repository/repo-kind'
import type { Repo } from '../../../../shared/repository/repo-types'
import type { GlobalSettings } from '../../../../shared/settings/global-settings-types'
import { normalizeSourceControlAiSettings } from '../../../../shared/source-control/ai/settings/source-control-ai-settings'
import { summarizeReposOverridingActionRecipe } from '../../../../shared/source-control/ai/source-control-launch-agent-selection'
import { TEXT_GENERATION_FAILURE_COPY } from '../../../../shared/text-generation/text-generation-failure-copy'
import {
  BRANCH_NAME_ENVIRONMENT_FAILED_HEADLINE,
  BRANCH_PUBLISHED_CHECK_FAILED_HEADLINE,
  WORKSPACE_NAME_ENVIRONMENT_FAILED_HEADLINE
} from '../../../../shared/worktree/branch-auto-rename-failure-headlines'
import { getRepoIdFromWorktreeId } from '../../../../shared/worktree/id'
import { watchForSettingsDeepLinkTarget } from '@/components/settings/navigation/settings-deep-link-target-watcher'

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

/** Where the branch-name agent that ran for this workspace is chosen, following how naming resolves it. */
export function branchNamingSettingsTarget(input: {
  worktreeId: string
  settings: Pick<GlobalSettings, 'sourceControlAi' | 'commitMessageAi'> | null
  repos: readonly Pick<Repo, 'id' | 'displayName' | 'kind' | 'sourceControlAi'>[]
}): SettingsNavigationTarget {
  const repoId = getRepoIdFromWorktreeId(input.worktreeId)
  // Folder workspaces name with the global recipe; only git repos have their own rows.
  const repo = input.repos.find((candidate) => candidate.id === repoId && !isFolderRepo(candidate))
  if (
    repo &&
    summarizeReposOverridingActionRecipe({ repos: [repo], actionId: 'branchName' }).count
  ) {
    return {
      pane: 'repo',
      repoId: repo.id,
      sectionId: getRepositorySourceControlAiActionRecipeSectionId(repo.id, 'branchName')
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

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

function firstVisibleControl(sectionId: string): HTMLElement | null {
  const section = document.getElementById(sectionId)
  if (!section || section.getClientRects().length === 0) {
    return null
  }
  for (const control of section.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)) {
    if (control.getClientRects().length > 0) {
      return control
    }
  }
  return null
}

/**
 * Opens Settings on the setting and moves focus to its first control once it is laid out, so
 * keyboard users land where the fix is. Callers keep the closing dialog from restoring focus.
 */
export function openNamingSettings(target: SettingsNavigationTarget): void {
  const store = useAppStore.getState()
  store.openSettingsPage()
  store.openSettingsTarget(target)
  const { sectionId } = target
  if (!sectionId || typeof document === 'undefined') {
    return
  }
  watchForSettingsDeepLinkTarget({
    root: document.body,
    waitForLayout: true,
    isTargetPresent: () => firstVisibleControl(sectionId) !== null,
    onTargetPresent: () => firstVisibleControl(sectionId)?.focus({ preventScroll: true })
  })
}
