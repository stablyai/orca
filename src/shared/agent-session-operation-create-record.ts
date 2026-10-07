/** What a create-worktree `agent.launch` records about its workspace before anything runs there. */
import {
  agentSessionOperationKey,
  type AgentSessionOperationRow
} from './agent-session-operation-ledger'

export type AgentSessionOperationCreateIntent = {
  repoId: string
  worktreePath: string
  branchName: string
  /** Minted before `git worktree add` and written into the made worktree's metadata, so a worktree
   *  found later at this path or branch is this create's only when its metadata names the same id. */
  instanceId: string
}

/** Adds bookkeeping to an existing row; a row that is gone (expired, never admitted) stays gone. */
export type AgentSessionOperationAnnotation = {
  callerKey: string
  operationId: string
  annotation: Pick<AgentSessionOperationRow, 'createIntent'>
}

export function annotateAgentSessionOperation(
  rows: ReadonlyMap<string, AgentSessionOperationRow>,
  args: AgentSessionOperationAnnotation
): Map<string, AgentSessionOperationRow> {
  const key = agentSessionOperationKey(args.callerKey, args.operationId)
  const next = new Map(rows)
  const existing = next.get(key)
  if (existing) {
    next.set(key, { ...existing, ...args.annotation })
  }
  return next
}

export function annotateAgentSessionOperationInto(
  state: { operations: Map<string, AgentSessionOperationRow> },
  args: AgentSessionOperationAnnotation
): void {
  state.operations = annotateAgentSessionOperation(state.operations, args)
}
