import { useAppStore } from '@/store'
import { getRepoRowIdentity, repoMatchesHostIdentity } from '@/store/repos/repo-host-identity'
import {
  TUI_AGENT_CONFIG,
  isTuiAgent
} from '../../../../shared/agent-launch/catalog/tui-agent-config'
import {
  needsAgentWorkspaceTrustDecision,
  type AgentWorkspaceTrustDecision
} from '../../../../shared/agent-launch/permissions/agent-workspace-trust-decision'
import {
  getConnectionExecutionHostId,
  getRepoExecutionHostId
} from '../../../../shared/execution-host'
import type { Repo } from '../../../../shared/repo-types'
import { parseWorkspaceKey } from '../../../../shared/workspace-scope'
import { splitWorktreeId } from '../../../../shared/worktree/id'

export type AgentWorkspaceTrustDecisionRequest = {
  repoId: string
  repoName: string
  hostId: ReturnType<typeof getRepoExecutionHostId>
}

/** The user's answer for this launch; null means no answer, so today's default applies. */
export type AgentWorkspaceTrustLaunchAnswer = AgentWorkspaceTrustDecision | null

/** An unanswered prompt releases its launches with today's default rather than holding them. */
export const AGENT_TRUST_PROMPT_TIMEOUT_MS = 120_000
/** A slow save must not hold the launch; the answer still applies to this launch. */
export const AGENT_TRUST_SAVE_WAIT_MS = 5_000

type PendingRequest = AgentWorkspaceTrustDecisionRequest & {
  rowIdentity: string
  settle: (answer: AgentWorkspaceTrustLaunchAnswer) => void
  timer?: ReturnType<typeof setTimeout>
  answering?: boolean
}

const queue: PendingRequest[] = []
const inFlightByRow = new Map<string, Promise<AgentWorkspaceTrustLaunchAnswer>>()
const listeners = new Set<() => void>()

function notifyListeners(): void {
  for (const listener of listeners) {
    listener()
  }
}

function release(request: PendingRequest, answer: AgentWorkspaceTrustLaunchAnswer): void {
  clearTimeout(request.timer)
  const index = queue.indexOf(request)
  if (index !== -1) {
    queue.splice(index, 1)
  }
  inFlightByRow.delete(request.rowIdentity)
  request.settle(answer)
  showNext()
}

/** The timeout starts when a request is on screen, so a queued repo is not timed out unseen. */
function showNext(): void {
  const next = queue[0]
  if (next && next.timer === undefined) {
    next.timer = setTimeout(() => {
      if (!next.answering) {
        release(next, null)
      }
    }, AGENT_TRUST_PROMPT_TIMEOUT_MS)
  }
  notifyListeners()
}

/** The PTY's own connection names the owning host; never fall back to the focused host. */
function repoForWorkspace(
  workspaceId: string | undefined,
  connectionId: string | null | undefined
): Repo | null {
  const scope = workspaceId ? parseWorkspaceKey(workspaceId) : null
  if (!workspaceId || scope?.type === 'folder') {
    return null
  }
  const repoId = splitWorktreeId(
    scope?.type === 'worktree' ? scope.worktreeId : workspaceId
  )?.repoId
  if (!repoId) {
    return null
  }
  const hostId = getConnectionExecutionHostId(connectionId)
  return (
    useAppStore.getState().repos.find((repo) => repoMatchesHostIdentity(repo, repoId, hostId)) ??
    null
  )
}

/** Null when no answer is needed, so launches that need none keep their synchronous path. */
export function awaitAgentWorkspaceTrustDecision(args: {
  launchAgent: unknown
  workspaceId: string | undefined
  connectionId: string | null | undefined
}): Promise<AgentWorkspaceTrustLaunchAnswer> | null {
  // No mounted dialog could answer, so never hold the launch.
  if (listeners.size === 0) {
    return null
  }
  if (!isTuiAgent(args.launchAgent) || !TUI_AGENT_CONFIG[args.launchAgent].preflightTrust) {
    return null
  }
  const repo = repoForWorkspace(args.workspaceId, args.connectionId)
  const globalEnabled = useAppStore.getState().settings?.agentWorkspaceTrustEnabled
  if (!repo || !needsAgentWorkspaceTrustDecision(globalEnabled, repo.agentWorkspaceTrust)) {
    return null
  }
  const rowIdentity = getRepoRowIdentity(repo)
  const existing = inFlightByRow.get(rowIdentity)
  if (existing) {
    return existing
  }
  const pending = new Promise<AgentWorkspaceTrustLaunchAnswer>((settle) => {
    queue.push({
      repoId: repo.id,
      repoName: repo.displayName,
      hostId: getRepoExecutionHostId(repo),
      rowIdentity,
      settle
    })
  })
  inFlightByRow.set(rowIdentity, pending)
  showNext()
  return pending
}

/** Saves the answer, then releases waiting launches with it even if the save fails or stalls. */
export async function answerAgentWorkspaceTrustDecision(
  decision: AgentWorkspaceTrustDecision
): Promise<void> {
  const request = queue[0]
  if (!request || request.answering) {
    return
  }
  request.answering = true
  clearTimeout(request.timer)
  let saveWait: ReturnType<typeof setTimeout> | undefined
  const saved = await Promise.race([
    useAppStore
      .getState()
      .updateRepo(request.repoId, { agentWorkspaceTrust: decision }, { hostId: request.hostId })
      .catch(() => false),
    new Promise<false>((resolve) => {
      saveWait = setTimeout(() => resolve(false), AGENT_TRUST_SAVE_WAIT_MS)
    })
  ])
  clearTimeout(saveWait)
  if (!saved) {
    console.warn(
      '[agent-trust] the repository answer was not saved; it applies to this launch only'
    )
  }
  release(request, decision)
}

export function getAgentWorkspaceTrustDecisionRequest(): AgentWorkspaceTrustDecisionRequest | null {
  return queue[0] ?? null
}

export function subscribeAgentWorkspaceTrustDecisionRequest(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
