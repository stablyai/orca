import { create, type StateCreator } from 'zustand'
import type { AppState } from '../types'
import type { Worktree } from '../../../../shared/worktree/types'
import { createRepoSlice } from '../repos/create-repo-slice'
import { createSparsePresetsSlice } from './sparse-presets'
import { createWorktreeSlice } from './worktrees'
import { createTerminalSlice } from './terminals'
import { createTabsSlice } from './tabs'
import { createUISlice } from './ui/create-ui-slice'
import { createSettingsSlice } from './settings/create-settings-slice'
import { createKeybindingsSlice } from './keybindings'
import { createGitHubSlice } from '../github/github'
import { createHostedReviewSlice } from './hosted-review/hosted-review'
import { createLinearSlice } from './linear/linear'
import { createPreflightSlice } from './preflight'
import { createJiraSlice } from './jira/jira'
import { createEditorSlice } from './editor/create-editor-slice'
import { createStatsSlice } from './stats'
import { createMemorySlice } from './memory'
import { createWorkspaceSpaceSlice } from './workspace-space'
import {
  createClaudeUsageSlice,
  createCodexUsageSlice,
  createMuseUsageSlice,
  createOpenCodeUsageSlice
} from './usage-provider-slices'
import { createBrowserSlice } from './browser/create-browser-slice'
import { createRateLimitSlice } from './rate-limits'
import { createSshSlice } from './ssh'
import { createRuntimeEnvironmentSshSlice } from './runtime-environment-ssh'
import { createWslHostsSlice } from './wsl-hosts'
import { createAgentStatusSlice } from './agent-status/agent-status'
import { createPaneForegroundAgentSlice } from './pane-foreground-agent'
import { createDiffCommentsSlice } from './diff-comments/create-diff-comments-slice'
import { createDetectedAgentsSlice } from './detected-agents'
import { createRuntimeDetectedAgentsSlice } from './runtime-detected-agents'
import { createWorktreeNavHistorySlice } from './worktree-nav-history'
import { createDictationSlice } from './dictation'
import { createWorkspaceCleanupSlice } from './workspace-cleanup/create-workspace-cleanup-slice'
import { createWorkspaceCleanupBrowseSlice } from './workspace-cleanup/workspace-cleanup-browse'
import { createRuntimeStatusSlice } from './runtime-status'
import { createPullRequestGenerationSlice } from './hosted-review/generation/pull-request-generation'
import { createCommitMessageGenerationSlice } from './commit-message-generation'
import { createPinnedTabCloseConfirmSlice } from './pinned-tab-close-confirm'
import { createRecentlyClosedTabsSlice } from './recently-closed-tabs'
import { createOrcaProfilesSlice } from './orca-profiles/create-orca-profiles-slice'
import { createNewIssueDraftSlice } from './new-issue-draft'
import { createFeedbackDraftSlice } from './feedback-draft'
import { createTaskCreationDraftsSlice } from './task-creation-drafts'
import { createRemoteServerUpdatesSlice } from './remote-server-updates'
import { createTerminalQuickCommandHostsSlice } from './terminal-quick-command-hosts'
import { createStructuredSessionLaunchDirectorySlice } from './structured-session-launch-directories'
import { createStructuredChatSleptAtSlice } from './structured-chat-slept-at'
import { createWorkspaceAttentionSlice } from './workspace-attention/workspace-attention-slice'
import '@/i18n/i18n'
import { withEditorBufferRecords } from '../editor-buffer-record-lifecycle'
import { withAgentConversationRetention } from '../agent-conversation-retention'
import { makeWorktree, TEST_REPO } from './worktrees-slice-test-fixtures'
export { makeWorktree, TEST_REPO } from './worktrees-slice-test-fixtures'
export {
  makeTab,
  makeLayout,
  makeOpenFile,
  makeUnifiedTab,
  makeTabGroup
} from './store-session-test-harness'

const withTestStorePolicies = (creator: StateCreator<AppState, [], []>, check: boolean) =>
  withEditorBufferRecords(withAgentConversationRetention(creator), check)

export function createTestStore(
  isClaudeAgent: Parameters<typeof createTerminalSlice>[3] = undefined
) {
  // Why the record middleware: views of one file share a record only through it, as in the app.
  return create<AppState>()(
    withTestStorePolicies(
      (...a) => ({
        ...createRepoSlice(...a),
        ...createSparsePresetsSlice(...a),
        ...createWorktreeSlice(...a),
        ...createTerminalSlice(...a, isClaudeAgent),
        ...createTabsSlice(...a),
        ...createUISlice(...a),
        ...createSettingsSlice(...a),
        ...createKeybindingsSlice(...a),
        ...createGitHubSlice(...a),
        ...createHostedReviewSlice(...a),
        ...createLinearSlice(...a),
        ...createPreflightSlice(...a),
        ...createJiraSlice(...a),
        ...createEditorSlice(...a),
        ...createStatsSlice(...a),
        ...createMemorySlice(...a),
        ...createWorkspaceSpaceSlice(...a),
        ...createClaudeUsageSlice(...a),
        ...createCodexUsageSlice(...a),
        ...createOpenCodeUsageSlice(...a),
        ...createMuseUsageSlice(...a),
        ...createBrowserSlice(...a),
        ...createRateLimitSlice(...a),
        ...createSshSlice(...a),
        ...createRuntimeEnvironmentSshSlice(...a),
        ...createWslHostsSlice(...a),
        ...createAgentStatusSlice(...a),
        ...createPaneForegroundAgentSlice(...a),
        ...createDiffCommentsSlice(...a),
        ...createDetectedAgentsSlice(...a),
        ...createRuntimeDetectedAgentsSlice(...a),
        ...createWorktreeNavHistorySlice(...a),
        ...createDictationSlice(...a),
        ...createWorkspaceCleanupSlice(...a),
        ...createWorkspaceCleanupBrowseSlice(...a),
        ...createRuntimeStatusSlice(...a),
        ...createPullRequestGenerationSlice(...a),
        ...createCommitMessageGenerationSlice(...a),
        ...createPinnedTabCloseConfirmSlice(...a),
        ...createRecentlyClosedTabsSlice(...a),
        ...createOrcaProfilesSlice(...a),
        ...createNewIssueDraftSlice(...a),
        ...createFeedbackDraftSlice(...a),
        ...createTaskCreationDraftsSlice(...a),
        ...createRemoteServerUpdatesSlice(...a),
        ...createTerminalQuickCommandHostsSlice(...a),
        ...createStructuredSessionLaunchDirectorySlice(...a),
        ...createStructuredChatSleptAtSlice(...a),
        ...createWorkspaceAttentionSlice(...a)
      }),
      true
    )
  )
}

export function seedStore(
  store: ReturnType<typeof createTestStore>,
  state: Partial<AppState>
): void {
  // Centralize fixture to keep cascade suites within max-lines limits without suppressing growth checks.
  store.setState({
    repos: [{ ...TEST_REPO, executionHostId: 'local' }],
    ...state
  })
}

export function makeRuntimeOwnedWorktree(
  overrides: Partial<Worktree> & { id: string; repoId: string },
  runtimeEnvironmentId = 'runtime-1'
): Worktree {
  return makeWorktree({
    ...overrides,
    hostId: overrides.hostId ?? 'local',
    runtimeOwnerEnvironmentId: runtimeEnvironmentId
  })
}

/** A repo stamped as owned by `environmentId`, the way ingest stamps fetched rows. */
export function runtimeOwnedRepoState(
  environmentId: string,
  id: string,
  path: string,
  extra: Partial<AppState> = {}
): Partial<AppState> {
  return {
    repos: [
      {
        id,
        path,
        displayName: 'repo',
        badgeColor: '',
        addedAt: 0,
        executionHostId: `runtime:${environmentId}`
      }
    ],
    ...extra
  }
}
