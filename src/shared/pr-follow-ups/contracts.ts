import type { AgentLaunchParams } from '../rpc-contract/agent-launch-params'
import type { PrFollowUpsSettings } from './settings'

export type FollowUpObservation = {
  prKey: string
  state: 'open' | 'closed' | 'merged'
  headSha: string
  headRefName: string
  baseSha: string
  mergeable: 'clean' | 'conflicting' | 'unknown'
  checksFinal: boolean
  failingCheckNames: string[]
  commentSignal: Record<
    'comments' | 'reviews' | 'threads',
    { totalCount: number; newestIds: string[] }
  >
  readComplete: boolean
  observedAt: number
}

export type FollowUpWorkspace = {
  instanceId: string
  repoPath: string
  connectionId: string | null
  branch: string
  prNumber: number | null
  archived: boolean
  settings?: PrFollowUpsSettings
}

export type FollowUpObservationSource = {
  watchWorkspace(
    watch: Pick<FollowUpWorkspace, 'repoPath' | 'connectionId' | 'branch' | 'prNumber'> & {
      reason: 'pr-follow-ups'
    }
  ): () => void
  subscribe(onObservation: (observation: FollowUpObservation) => void): () => void
  latest(prKey: string): FollowUpObservation | undefined
  pullRequestActionsFor?(prKey: string): readonly { headSha: string; chatId: string }[]
}

export type FollowUpTarget = {
  worktreeId: string
  instanceId: string
  prKey: string
  branch: string
  lastActiveAt: number
  archived: boolean
  settings?: PrFollowUpsSettings
  workingAgent: string | null
}

export type FollowUpAction = {
  actionKey: string
  prKey: string
  headSha: string
  failingNames: string[]
  mode: 'new-agent'
  worktreeId: string
  instanceId: string
  generation: number
  attempt: number
  attemptStartedAt: number
  operationId: string
  status: 'claimed' | 'accepted' | 'absent' | 'unconfirmed' | 'declined'
  launch: AgentLaunchParams
  sessionId?: string
  terminalHandle?: string
  paneKey?: string
  terminalPtyId?: string
  transcriptChatId?: string
  surface?: 'chat' | 'terminal'
  promptUnconfirmed?: boolean
  sessionStartedAt?: number
  sessionEndedAt?: number
}

export type FollowUpActionMetadata = Omit<FollowUpAction, 'launch'> & { agent: string }

export type FollowUpPr = {
  prKey: string
  baselineAt: number | null
  needsBaseline: boolean
  headSha: string
  // Only complete, non-cached observations advance the head provenance boundary.
  lastSeenAt: number
  lastReadAt?: number
  handled: string[]
  baselineNames: string[]
  generation: number
  stoppedAt: number | null
  consecutiveReadFailures: number
  consecutiveCommentWakes: number
  pendingRead: boolean
  state: FollowUpObservation['state']
}

export type FollowUpView = {
  state:
    | 'off'
    | 'armed'
    | 'waiting'
    | 'waiting-window'
    | 'handled'
    | 'paused'
    | 'baseline'
    | 'unconfirmed'
    | 'starting'
    | 'prompt-unconfirmed'
  used: number
  limit: number
  stopped: boolean
  offReason?: 'disabled' | 'nothing' | 'branch' | 'stopped'
  pauseReason?: 'generation' | 'daily' | 'reads' | 'comments'
  resumesAt?: number
  workingAgent?: string
  action?: Pick<FollowUpAction, 'worktreeId' | 'sessionId' | 'paneKey' | 'surface'>
}

export type FollowUpSnapshot = {
  available: boolean
  workspaces: Record<string, { prKey: string; view: FollowUpView; fixing: boolean } | null>
}
