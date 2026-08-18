import React from 'react'
import { SourceControlPanel } from './source-control/panel/panel'

export { HostedReviewHeaderLink } from './source-control/review/hosted-review-header-chrome'

export {
  CompareSummary,
  CompareSummaryToolbarButton,
  shouldRefreshBranchCompareForRemoteStatus,
  shouldRefreshBranchCompareForStatusHead,
  shouldShowCompareSummary
} from './source-control/sync/compare-summary'
export {
  ConflictSummaryCard,
  OperationBanner
} from './source-control/listing/conflict-status-cards'
export { TooManyChangesBanner } from './source-control/listing/too-many-changes-banner'
export { ActionButton } from './source-control/listing/action-button'
export { BRANCH_REFRESH_INTERVAL_MS } from './source-control/sync/use-branch-compare'
export { CommitArea } from './source-control/commit/commit-area'
export { handleSourceControlCommitShortcut } from './source-control/commit/commit-shortcut'
export {
  resolveSourceControlBaseRef,
  resolveSourceControlCompareBaseRef,
  resolveSourceControlPickerBaseRef,
  shouldClearBranchCompareForMissingBase
} from './source-control/sync/base-ref-resolution'
export {
  normalizeSourceControlViewMode,
  readCommitDraftForWorktree,
  writeCommitDraftForWorktree
} from './source-control/commit/commit-drafts'
export {
  pickDefaultSourceControlAgent,
  shouldRenderCommitArea
} from './source-control/commit/component-gates'
export {
  clearRemoteActionErrorsForCompletedConflictOperations,
  refreshSourceControlAfterRemoteAction
} from './source-control/sync/remote-refresh'

export {
  appendCommitFailureCustomInstruction,
  appendPushFailureCustomInstruction,
  buildCommitFailureAgentCommandInput,
  buildFixCommitFailurePrompt,
  buildFixPushFailurePrompt,
  buildPushFailureAgentCommandInput,
  buildResolveConflictsPrompt,
  buildResolvePullRequestConflictsPrompt
} from './source-control/ai/prompts'
export {
  hasConfiguredCommitMessageGenerationDefaults,
  hasConfiguredSourceControlTextGenerationDefaults
} from './source-control/ai/text-generation-defaults'

function SourceControlInner(): React.JSX.Element {
  return <SourceControlPanel />
}
const SourceControl = React.memo(SourceControlInner)
export default SourceControl
