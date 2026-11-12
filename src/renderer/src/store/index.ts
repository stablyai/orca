import { registerTerminalNoticeShutdownReader } from '@/components/terminal-pane/pty-transport/delivery/pty-notice-exit'
import { registerStructuredSelectionCatalogStore } from '@/lib/agent-session/options/structured-agent-session-selection-controller'
import { canOfferHttpLinkGroupAction } from '@/lib/browser/navigation/http-link-in-group-availability'
import { create, type StateCreator } from 'zustand'
import type { AppState } from './types'
import { createRepoSlice } from './repos/create-repo-slice'
import { createSparsePresetsSlice } from './slices/worktrees/create/sparse-presets'
import { createWorktreeSlice } from './slices/worktrees/create-worktree-slice'
import { createTerminalSlice } from './terminals/create-terminal-slice'
import { createTabsSlice } from './slices/tabs/create-tabs-slice'
import { createUISlice } from './slices/ui/create-ui-slice'
import { createSettingsSlice } from './slices/settings/create-settings-slice'
import { createKeybindingsSlice } from './slices/keybindings/keybindings'
import { createGitHubSlice } from './github/github'
import { createHostedReviewSlice } from './slices/hosted-review/hosted-review'
import { createLinearSlice } from './slices/linear/linear'
import { createPreflightSlice } from './slices/preflight/preflight'
import { createJiraSlice } from './slices/jira/jira'
import { createEditorSlice } from './slices/editor/create-editor-slice'
import { createStatsSlice } from './slices/process-stats/stats'
import { createMemorySlice } from './slices/process-stats/memory'
import { createWorkspaceSpaceSlice } from './slices/workspace-cleanup/workspace-space'
import {
  createClaudeUsageSlice,
  createCodexUsageSlice,
  createMuseUsageSlice,
  createOpenCodeUsageSlice
} from './slices/usage/usage-provider-slices'
import { createBrowserSlice } from './slices/browser/create-browser-slice'
import { createRateLimitSlice } from './slices/usage/rate-limits'
import { createSshSlice } from './slices/ssh/create-ssh-slice'
import { createRuntimeEnvironmentSshSlice } from './slices/ssh/runtime-environment-ssh'
import { createWslHostsSlice } from './slices/wsl/wsl-hosts'
import { createAgentStatusSlice } from './slices/agent-status/agent-status'
import { createPaneForegroundAgentSlice } from './slices/agent-status/pane-foreground-agent'
import { createDiffCommentsSlice } from './slices/diff-comments/create-diff-comments-slice'
import { createDetectedAgentsSlice } from './slices/agent-inventory/create-detected-agents-slice'
import { createRuntimeDetectedAgentsSlice } from './slices/agent-inventory/runtime-detected-agents'
import { createWorktreeNavHistorySlice } from './slices/ui/workspace-navigation-history'
import { createDictationSlice } from './slices/dictation/dictation'
import { createWorkspaceCleanupSlice } from './slices/workspace-cleanup/create-workspace-cleanup-slice'
import { createWorkspaceCleanupBrowseSlice } from './slices/workspace-cleanup/workspace-cleanup-browse'
import { createRuntimeStatusSlice } from './slices/runtime-status/create-runtime-status-slice'
import { createPullRequestGenerationSlice } from './slices/hosted-review/generation/pull-request-generation'
import { createCommitMessageGenerationSlice } from './slices/hosted-review/generation/commit-message-generation'
import { createPinnedTabCloseConfirmSlice } from './slices/tabs/pinned-tab-close-confirm'
import { createRecentlyClosedTerminalTabsSlice } from './terminals/recently-closed-terminal-tabs'
import { createRecentlyClosedTabsSlice } from './slices/tabs/recently-closed-tabs'
import { createOrcaProfilesSlice } from './slices/orca-profiles/create-orca-profiles-slice'
import { createNewIssueDraftSlice } from './slices/task-creation/new-issue-draft'
import { createFeedbackDraftSlice } from './slices/feedback/feedback-draft'
import { createTaskCreationDraftsSlice } from './slices/task-creation/task-creation-drafts'
import { createRemoteServerUpdatesSlice } from './slices/runtime-host-updates/remote-server-updates'
import { createTerminalQuickCommandHostsSlice } from './terminals/terminal-quick-command-hosts'
import { createStructuredSessionLaunchDirectorySlice } from './slices/agent-status/structured-session-launch-directories'
import { createStructuredChatSleptAtSlice } from './slices/agent-status/structured-chat-slept-at'
import { createStructuredChatCompanionWritesSlice } from './slices/agent-status/structured-chat-companion-writes'
import { createEphemeralVmLifecycleSlice } from './slices/ephemeral-vm/ephemeral-vm-lifecycle'
import { createWorkspaceAttentionSlice } from './slices/workspace-attention/workspace-attention-slice'
import { e2eConfig } from '@/app-shell/startup/e2e-config'
import type { createWebRuntimeSessionTerminal } from '@/runtime/hosted-terminals/creation/web-runtime-terminal-creation'
import {
  registerHttpLinkStoreAccessor,
  registerHttpLinkGroupActionAvailability,
  registerWorkspaceHttpLinkBrowserOpener
} from '@/lib/browser/navigation/http-link-routing'
import { registerAppHttpLinkStateAccessor } from '@/lib/browser/navigation/app-http-link-open'
import { installStoreListenerCensus } from './diagnostics/store-listener-census'
import { installSettledSortEpoch } from './slices/ui/settled-sort-epoch'
import { ORCA_SIDEBAR_INPUTS_IS_MAIN } from '../../../shared/sidebar-inputs-switch'
import { withReactCommitCascadeWriteProbe } from './diagnostics/react-commit-cascade-write-probe'
import { withStoreIdentityChurnProbe } from './diagnostics/store-identity-churn-probe'
import { withEditorBufferRecords } from './slices/editor/buffers/editor-buffer-record-lifecycle'
import { withAgentConversationRetention } from './slices/agent-status/agent-conversation-retention'
import { attachEditorBufferIdentityEvents } from './slices/editor/buffers/editor-buffer-identity-events'
import {
  registerRendererMemoryProfileContributor,
  summarizeStateCollectionSizes
} from '@/diagnostics/memory/renderer-memory-profile'
import { estimateStateCollectionKB } from '@/diagnostics/memory/state-collection-byte-estimate'
import { registerWindowsPathAccessEnvironments } from '@/lib/files/os-open/windows-path-access'
import { STORE_OBSERVER_INSTALLERS } from './store-observer-installers'

// Dev-only churn probe cannot be armed in shipped builds; avoid its per-write wrapper. Cascade probe stays enabled for field crash telemetry.
const withDevelopmentStoreProbes = (createState: StateCreator<AppState, [], []>) =>
  import.meta.env.DEV || e2eConfig.exposeStore
    ? withStoreIdentityChurnProbe(createState)
    : createState

const withAppStoreWritePolicies = (createState: StateCreator<AppState, [], []>) =>
  withAgentConversationRetention(withDevelopmentStoreProbes(createState))

// Why buffer records outermost: the probes must see each caller's own partial and frame.
// Why e2e checks the buffer invariant too: a writer that skips the record must fail there, not drift.
export const useAppStore = create<AppState>()(
  withEditorBufferRecords(
    withAppStoreWritePolicies(
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
          ...createStructuredChatCompanionWritesSlice(...a),
          ...createWorkspaceAttentionSlice(...a),
          ...createEphemeralVmLifecycleSlice(...a)
        }
      })
    ),
    import.meta.env.DEV || e2eConfig.exposeStore
  )
)

registerTerminalNoticeShutdownReader(
  (ptyId) => (useAppStore.getState().pendingPtyShutdownIds[ptyId] ?? 0) > 0
)

for (const install of STORE_OBSERVER_INSTALLERS) {
  install(useAppStore)
}

registerStructuredSelectionCatalogStore({
  read: useAppStore.getState,
  subscribe: useAppStore.subscribe
})
registerHttpLinkStoreAccessor(() => useAppStore.getState(), useAppStore.subscribe)
registerHttpLinkGroupActionAvailability((request) =>
  canOfferHttpLinkGroupAction(useAppStore.getState(), request)
)
registerAppHttpLinkStateAccessor(() => useAppStore.getState())
attachEditorBufferIdentityEvents(() => useAppStore.getState())
registerWindowsPathAccessEnvironments(() => useAppStore.getState().runtimeEnvironments)
registerWorkspaceHttpLinkBrowserOpener(async (request) => {
  const { openWorkspaceBrowserTab, openWorkspaceBrowserTabForLink } =
    await import('@/lib/browser/workspace/workspace-browser-tab-open')
  if (request.linkContext) {
    const outcome = await openWorkspaceBrowserTabForLink({
      ...request,
      linkContext: request.linkContext
    })
    if (
      outcome.status === 'failed' ||
      (outcome.status === 'refused' && !request.linkContext.linkIntent?.targetGroupId)
    ) {
      const { intentPresentation } =
        await import('@/lib/browser/workspace/workspace-browser-tab-presentation')
      throw new Error(intentPresentation(request.intent, request.url).error)
    }
    if (
      request.linkContext.linkIntent?.targetGroupId &&
      (outcome.status === 'refused' || outcome.status === 'unsupported')
    ) {
      const { showOpenInGroupRefusedToast } =
        await import('@/components/terminal-pane/links/files/terminal-file-open-in-group-toast')
      showOpenInGroupRefusedToast(request.url)
    }
    return outcome.status === 'opened' ? outcome.result.browserPageId : null
  }
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

// Expose store for dev console or VITE_EXPOSE_STORE E2E assertions, avoiding fragile DOM scraping.
if ((import.meta.env.DEV || e2eConfig.exposeStore) && typeof window !== 'undefined') {
  const testWindow = window as unknown as Record<string, unknown>
  testWindow.__store = useAppStore
  if (e2eConfig.exposeStore) {
    testWindow.__webRuntimeSessionE2E = {
      createTerminal: async (args: Parameters<typeof createWebRuntimeSessionTerminal>[0]) =>
        (
          await import('@/runtime/hosted-terminals/creation/web-runtime-terminal-creation')
        ).createWebRuntimeSessionTerminal(args)
    }
  }
}
