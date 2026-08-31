import type { HostedReviewCreationEligibility } from '../../../../../shared/hosted-review'
import type { PendingPRCommentAiAck } from '../pr-comments-ai-launch-ack'
import type { SourceControlLaunchActionId } from '../../../../../shared/source-control-ai-actions'

export type HostedReviewCreationSnapshot = {
  requestKey: string
  contextKey: string
  repoId: string
  worktreeId: string | null
  branch: string
  requestStartedAt: number
  completedAt: number
  gitFingerprint: string
  data: HostedReviewCreationEligibility
}

export type ChecksAgentComposerState = {
  actionId: SourceControlLaunchActionId
  title: string
  description: string
  prompt: string
  launchSource: 'conflict_resolution' | 'task_page'
  commentResolution?: PendingPRCommentAiAck
}
