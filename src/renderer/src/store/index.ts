import { create, type StateCreator } from 'zustand'
import type { AppState } from './types'
import { createRepoSlice } from './slices/repos'
import { createSparsePresetsSlice } from './slices/sparse-presets'
import { createWorktreeSlice } from './slices/worktrees'
import { createTerminalSlice } from './slices/terminals'
import { createTabsSlice } from './slices/tabs'
import { createUISlice } from './slices/ui'
import { createSettingsSlice } from './slices/settings'
import { createKeybindingsSlice } from './slices/keybindings'
import { createGitHubSlice } from './slices/github'
import { createHostedReviewSlice } from './slices/hosted-review'
import { createLinearSlice } from './slices/linear'
import { createPreflightSlice } from './slices/preflight'
import { createJiraSlice } from './slices/jira'
import { createEditorSlice } from './slices/editor'
import { createStatsSlice } from './slices/stats'
import { createMemorySlice } from './slices/memory'
import { createWorkspaceSpaceSlice } from './slices/workspace-space'
import {
  createClaudeUsageSlice,
  createCodexUsageSlice,
  createMuseUsageSlice,
  createOpenCodeUsageSlice
} from './slices/usage-provider-slices'
import { createBrowserSlice } from './slices/browser'
import { createRateLimitSlice } from './slices/rate-limits'
import { createSshSlice } from './slices/ssh'
import { createRuntimeEnvironmentSshSlice } from './slices/runtime-environment-ssh'
import { createWslHostsSlice } from './slices/wsl-hosts'
import { createAgentStatusSlice } from './slices/agent-status'
import { createPaneForegroundAgentSlice } from './slices/pane-foreground-agent'
import { createDiffCommentsSlice } from './slices/diffComments'
import { createDetectedAgentsSlice } from './slices/detected-agents'
import { createRuntimeDetectedAgentsSlice } from './slices/runtime-detected-agents'
import { createWorktreeNavHistorySlice } from './slices/worktree-nav-history'
import { createDictationSlice } from './slices/dictation'
import { createWorkspaceCleanupSlice } from './slices/workspace-cleanup'
import { createWorkspaceCleanupBrowseSlice } from './slices/workspace-cleanup-browse'
import { createRuntimeStatusSlice } from './slices/runtime-status'
import { createPullRequestGenerationSlice } from './slices/pull-request-generation'
import { createCommitMessageGenerationSlice } from './slices/commit-message-generation'
import { createPinnedTabCloseConfirmSlice } from './slices/pinned-tab-close-confirm'
import { createRecentlyClosedTabsSlice } from './slices/recently-closed-tabs'
import { createOrcaProfilesSlice } from './slices/orca-profiles'
import { createNewIssueDraftSlice } from './slices/new-issue-draft'
import { createFeedbackDraftSlice } from './slices/feedback-draft'
import { createTaskCreationDraftsSlice } from './slices/task-creation-drafts'
import { createRemoteServerUpdatesSlice } from './slices/remote-server-updates'
import { createTerminalQuickCommandHostsSlice } from './slices/terminal-quick-command-hosts'
import { createStructuredSessionLaunchDirectorySlice } from './slices/structured-session-launch-directories'
import { createStructuredChatSleptAtSlice } from './slices/structured-chat-slept-at'
import { createWorkspaceAttentionSlice } from './slices/workspace-attention/workspace-attention-slice'
import { e2eConfig } from '@/lib/e2e-config'
import type { createWebRuntimeSessionTerminal } from '@/runtime/web-runtime-terminal-creation'
import {
  registerHttpLinkStoreAccessor,
  registerWorkspaceHttpLinkBrowserOpener
} from '@/lib/http-link-routing'
import { installStoreListenerCensus } from './store-listener-census'
import { installSettledSortEpoch } from './settled-sort-epoch'
import { ORCA_SIDEBAR_INPUTS_IS_MAIN } from '../../../shared/sidebar-inputs-switch'
import { withReactCommitCascadeWriteProbe } from './react-commit-cascade-write-probe'
import { withStoreIdentityChurnProbe } from './store-identity-churn-probe'
import { withEditorBufferRecords } from './editor-buffer-record-lifecycle'
import { attachEditorBufferIdentityEvents } from './editor-buffer-identity-events'
import {
  registerRendererMemoryProfileContributor,
  summarizeStateCollectionSizes
} from '@/lib/renderer-memory-profile'
import { estimateStateCollectionKB } from '@/lib/state-collection-byte-estimate'
import { registerWindowsPathAccessEnvironments } from '@/lib/windows-path-access'

// Dev-only churn probe cannot be armed in shipped builds; avoid its per-write wrapper. Cascade probe stays enabled for field crash telemetry.
const withDevelopmentStoreProbes = (createState: StateCreator<AppState, [], []>) =>
  import.meta.env.DEV || e2eConfig.exposeStore
    ? withStoreIdentityChurnProbe(createState)
    : createState

// Why buffer records outermost: the probes must see each caller's own partial and frame.
// Why e2e checks the buffer invariant too: a writer that skips the record must fail there, not drift.
export const useAppStore = create<AppState>()(
  withEditorBufferRecords(
    withDevelopmentStoreProbes(
      withReactCommitCascadeWriteProbe((...a) => {
        // Why first: settling inside the bump's own notify means hook subscribers never see it unsettled.
        // Switch point: the stamp-sorted list reads no settled epoch.
        if (!ORCA_SIDEBAR_INPUTS_IS_MAIN) {
          installSettledSortEpoch(a[2])
        }
        // Why: the inner api is only reachable here, before create() copies subscribe onto the hook.
        installStoreListenerCensus(a[2])
        return {
          ...createRepoSlice(...a),
          ...createSparsePresetsSlice(...a),
          ...createWorktreeSlice(...a),
          ...createTerminalSlice(...a),
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
        }
      })
    ),
    import.meta.env.DEV || e2eConfig.exposeStore
  )
)

registerHttpLinkStoreAccessor(() => useAppStore.getState())
attachEditorBufferIdentityEvents(() => useAppStore.getState())
registerWindowsPathAccessEnvironments(() => useAppStore.getState().runtimeEnvironments)
registerWorkspaceHttpLinkBrowserOpener(async (request) => {
  const { openWorkspaceBrowserTab } = await import('@/lib/workspace-browser-tab-open')
  return openWorkspaceBrowserTab(request)
})

// Name largest slices in renderer_memory_highwater breadcrumbs so OOM reports identify growth without local repro.
registerRendererMemoryProfileContributor('store', () =>
  summarizeStateCollectionSizes(useAppStore.getState(), 20)
)

// Sample bytes too: value-weight leaks can add ~700MB through only four entries (97b9e86d).
registerRendererMemoryProfileContributor('storeKB', () =>
  estimateStateCollectionKB(useAppStore.getState(), 16)
)

export type { AppState } from './types'

// Expose store for dev console or VITE_EXPOSE_STORE E2E assertions, avoiding fragile DOM scraping.
if ((import.meta.env.DEV || e2eConfig.exposeStore) && typeof window !== 'undefined') {
  const testWindow = window as unknown as Record<string, unknown>
  testWindow.__store = useAppStore
  if (e2eConfig.exposeStore) {
    testWindow.__webRuntimeSessionE2E = {
      createTerminal: async (args: Parameters<typeof createWebRuntimeSessionTerminal>[0]) =>
        (await import('@/runtime/web-runtime-terminal-creation')).createWebRuntimeSessionTerminal(
          args
        )
    }
  }
}
