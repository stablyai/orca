import { useAppStore } from '@/store'
import { findRepoForHost, getRepoRowIdentity } from '@/store/slices/repo-host-identity'
import {
  TUI_AGENT_CONFIG,
  isTuiAgent
} from '../../../../shared/agent-launch/catalog/tui-agent-config'
import {
  needsAgentWorkspaceTrustDecision,
  type AgentWorkspaceTrustDecision
} from '../../../../shared/agent-workspace-trust-decision'
import { getRepoExecutionHostId } from '../../../../shared/execution-host'
import type { Repo } from '../../../../shared/repo-types'
import { parseWorkspaceKey } from '../../../../shared/workspace-scope'
import { splitWorktreeId } from '../../../../shared/worktree/id'

export type AgentWorkspaceTrustDecisionRequest = {
  repoId: string
  repoName: string
  hostId: ReturnType<typeof getRepoExecutionHostId>
}

type PendingRequest = AgentWorkspaceTrustDecisionRequest & {
  rowIdentity: string
  settle: () => void
  answering?: boolean
}

const queue: PendingRequest[] = []
const inFlightByRow = new Map<string, Promise<void>>()
const listeners = new Set<() => void>()

function notifyListeners(): void {
  for (const listener of listeners) {
    listener()
  }
}

function repoForWorkspace(workspaceId: string | undefined): Repo | null {
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
  const { repos, settings } = useAppStore.getState()
  return findRepoForHost(repos, repoId, { settings })
}

/** Null when no answer is needed, so launches that need none keep their synchronous path. */
export function awaitAgentWorkspaceTrustDecision(args: {
  launchAgent: unknown
  workspaceId: string | undefined
}): Promise<void> | null {
  if (!isTuiAgent(args.launchAgent) || !TUI_AGENT_CONFIG[args.launchAgent].preflightTrust) {
    return null
  }
  const repo = repoForWorkspace(args.workspaceId)
  const globalEnabled = useAppStore.getState().settings?.agentWorkspaceTrustEnabled
  if (!repo || !needsAgentWorkspaceTrustDecision(globalEnabled, repo.agentWorkspaceTrust)) {
    return null
  }
  const rowIdentity = getRepoRowIdentity(repo)
  const existing = inFlightByRow.get(rowIdentity)
  if (existing) {
    return existing
  }
  const pending = new Promise<void>((settle) => {
    queue.push({
      repoId: repo.id,
      repoName: repo.displayName,
      hostId: getRepoExecutionHostId(repo),
      rowIdentity,
      settle
    })
  })
  inFlightByRow.set(rowIdentity, pending)
  notifyListeners()
  return pending
}

/** Saves before releasing the launch: the spawn reads the repo's stored answer. */
export async function answerAgentWorkspaceTrustDecision(
  decision: AgentWorkspaceTrustDecision
): Promise<void> {
  const request = queue[0]
  if (!request || request.answering) {
    return
  }
  request.answering = true
  try {
    const saved = await useAppStore
      .getState()
      .updateRepo(request.repoId, { agentWorkspaceTrust: decision }, { hostId: request.hostId })
    if (!saved) {
      console.warn('[agent-trust] could not save the repository decision; it will be asked again')
    }
  } finally {
    queue.splice(queue.indexOf(request), 1)
    inFlightByRow.delete(request.rowIdentity)
    request.settle()
    notifyListeners()
  }
}

export function getAgentWorkspaceTrustDecisionRequest(): AgentWorkspaceTrustDecisionRequest | null {
  return queue[0] ?? null
}

export function subscribeAgentWorkspaceTrustDecisionRequest(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
