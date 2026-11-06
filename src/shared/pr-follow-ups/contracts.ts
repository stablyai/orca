import type { AgentLaunchParams } from '../rpc-contract/agent-launch-params'
import type { PRMergeableState } from '../github/pull-request-types'
import type { PrFollowUpsSettings } from './settings'

export type FollowUpObservation = {
  prKey: string
  state: 'open' | 'draft' | 'closed' | 'merged'
  headSha: string
  headRefName: string
  baseSha?: string | null
  mergeable?: PRMergeableState
  checksFinal: boolean
  failingCheckNames: string[]
  readComplete: boolean
  observedAt: number
}

export type FollowUpWorkspace = {
  worktreeId: string
  instanceId: string
  repoId: string
  connectionId: string | null
  branch: string
  prNumber: number | null
  archived: boolean
  settings?: PrFollowUpsSettings
}

export type FollowUpObservationSource = {
  registerPRWatch(watch: {
    repoId: string
    connectionId?: string | null
    branch: string
    prNumber: number | null
    reason: 'pr-follow-ups'
  }): { unregister(): void }
  subscribePRObservations(onObservation: (observation: FollowUpObservation) => void): () => void
  latest(prKey: string): FollowUpObservation | undefined
  pullRequestActionsFor?(prKey: string): readonly {
    headSha: string | null
    chatId: string
    kind: 'opened' | 'pushed'
    anchor: { itemId: string; revision: number }
    observedAt: number
  }[]
  ownerChatFor?(prKey: string): string | null
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
  status: 'claimed' | 'accepted' | 'absent' | 'unconfirmed' | 'declined' | 'failed'
  agent: string
  failureReason?: string
  sessionId?: string
  terminalHandle?: string
  paneKey?: string
  terminalPtyId?: string
  transcriptChatId?: string
  surface?: 'chat' | 'terminal'
  promptUnconfirmed?: boolean
  recoveryFinalizedAt?: number
  retryKey?: string
  retryCount?: number
  retryObservedAt?: number
  sessionStartedAt?: number
  sessionEndedAt?: number
}

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
    | 'failed'
    | 'prompt-unconfirmed'
  used: number
  limit: number
  stopped: boolean
  offReason?: 'disabled' | 'nothing' | 'branch' | 'stopped'
  pauseReason?: 'generation' | 'daily' | 'reads'
  failureReason?: string
  resumesAt?: number
  workingAgent?: string
  action?: Pick<FollowUpAction, 'worktreeId' | 'sessionId' | 'paneKey' | 'surface'>
}

export type FollowUpSnapshot = {
  available: boolean
  workspaces: Record<string, { prKey: string; view: FollowUpView; fixing: boolean } | null>
}

export type FollowUpWorking = boolean | 'unknown' | { working: boolean; at: number }

// Complete inventory includes persisted archived, disabled, hidden and disconnected instances.
export type FollowUpHostInputs = {
  // Inventory snapshots and their items retain identity until their follow-up inputs change.
  targets(): readonly FollowUpTarget[]
  target(worktreeId: string): FollowUpTarget | undefined
  // Authoritatively publishes every new instance, including the first workspace of an unknown repo.
  subscribeInventory(listener: (change: { deletedInstanceId?: string }) => void): () => void
  workspaces(): readonly FollowUpWorkspace[]
  liveInstanceIds(): ReadonlySet<string>
  inventoryComplete(): boolean
  launchInputs(target: FollowUpTarget): { key: string; agent: string }
  recipe(target: FollowUpTarget): { agent: string; surface: 'terminal' | 'chat' }
  prepare(
    observation: FollowUpObservation,
    names: string[],
    target: FollowUpTarget
  ): Promise<AgentLaunchParams>
  live(action: FollowUpAction): Promise<boolean | 'unknown'>
  // False requires positive idle/turn-end evidence; absence, rest and stale titles are unknown.
  working(action: FollowUpAction): FollowUpWorking
  started?(action: FollowUpAction): void
}
