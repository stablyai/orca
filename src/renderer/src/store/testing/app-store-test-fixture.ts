import { create, type StateCreator } from 'zustand'
import type { AppState } from '../types'

import { createRepoSlice } from '../repos/create-repo-slice'
import { createSparsePresetsSlice } from '../slices/worktrees/create/sparse-presets'
import { createWorktreeSlice } from '../slices/worktrees/create-worktree-slice'
import { createTerminalSlice } from '../terminals/create-terminal-slice'
import { createTabsSlice } from '../slices/tabs/create-tabs-slice'
import { createUISlice } from '../slices/ui/create-ui-slice'
import { createSettingsSlice } from '../slices/settings/create-settings-slice'
import { createKeybindingsSlice } from '../slices/keybindings/keybindings'
import { createGitHubSlice } from '../github/github'
import { createHostedReviewSlice } from '../slices/hosted-review/hosted-review'
import { createLinearSlice } from '../slices/linear/linear'
import { createPreflightSlice } from '../slices/preflight/preflight'
import { createJiraSlice } from '../slices/jira/jira'
import { createEditorSlice } from '../slices/editor/create-editor-slice'
import { createStatsSlice } from '../slices/process-stats/stats'
import { createMemorySlice } from '../slices/process-stats/memory'
import { createWorkspaceSpaceSlice } from '../slices/workspace-cleanup/workspace-space'
import {
  createClaudeUsageSlice,
  createCodexUsageSlice,
  createMuseUsageSlice,
  createOpenCodeUsageSlice
} from '../slices/usage/usage-provider-slices'
import { createBrowserSlice } from '../slices/browser/create-browser-slice'
import { createRateLimitSlice } from '../slices/usage/rate-limits'
import { createSshSlice } from '../slices/ssh/create-ssh-slice'
import { createRuntimeEnvironmentSshSlice } from '../slices/ssh/runtime-environment-ssh'
import { createWslHostsSlice } from '../slices/wsl/wsl-hosts'
import { createAgentStatusSlice } from '../slices/agent-status/agent-status'
import { createPaneForegroundAgentSlice } from '../slices/agent-status/pane-foreground-agent'
import { createDiffCommentsSlice } from '../slices/diff-comments/create-diff-comments-slice'
import { createDetectedAgentsSlice } from '../slices/agent-inventory/create-detected-agents-slice'
import { createRuntimeDetectedAgentsSlice } from '../slices/agent-inventory/runtime-detected-agents'
import { createWorktreeNavHistorySlice } from '../slices/ui/workspace-navigation-history'
import { createDictationSlice } from '../slices/dictation/dictation'
import { createWorkspaceCleanupSlice } from '../slices/workspace-cleanup/create-workspace-cleanup-slice'
import { createWorkspaceCleanupBrowseSlice } from '../slices/workspace-cleanup/workspace-cleanup-browse'
import { createRuntimeStatusSlice } from '../slices/runtime-status/create-runtime-status-slice'
import { createPullRequestGenerationSlice } from '../slices/hosted-review/generation/pull-request-generation'
import { createCommitMessageGenerationSlice } from '../slices/hosted-review/generation/commit-message-generation'
import { createPinnedTabCloseConfirmSlice } from '../slices/tabs/pinned-tab-close-confirm'
import { createRecentlyClosedTerminalTabsSlice } from '../terminals/recently-closed-terminal-tabs'
import { createRecentlyClosedTabsSlice } from '../slices/tabs/recently-closed-tabs'
import { createOrcaProfilesSlice } from '../slices/orca-profiles/create-orca-profiles-slice'
import { createNewIssueDraftSlice } from '../slices/task-creation/new-issue-draft'
import { createFeedbackDraftSlice } from '../slices/feedback/feedback-draft'
import { createTaskCreationDraftsSlice } from '../slices/task-creation/task-creation-drafts'
import { createRemoteServerUpdatesSlice } from '../slices/runtime-host-updates/remote-server-updates'
import { createTerminalQuickCommandHostsSlice } from '../terminals/terminal-quick-command-hosts'
import { createStructuredSessionLaunchDirectorySlice } from '../slices/agent-status/structured-session-launch-directories'
import { createStructuredChatSleptAtSlice } from '../slices/agent-status/structured-chat-slept-at'
import { createWorkspaceAttentionSlice } from '../slices/workspace-attention/workspace-attention-slice'
import '@/i18n/i18n'
import { withEditorBufferRecords } from '../slices/editor/buffers/editor-buffer-record-lifecycle'
import { withAgentConversationRetention } from '../slices/agent-status/agent-conversation-retention'
import { TEST_REPO } from '../repos/repo.test-fixture'

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
        ...createRecentlyClosedTerminalTabsSlice(...a),
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
