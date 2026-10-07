import type { ExecutionHostId } from '../execution-host'

/**
 * One supervised worker a coordinator on this runtime placed on another Orca
 * server.
 *
 * Git lineage cannot record it: a child worktree's parent must be in the same
 * repository on the same execution host, and each host mints its own repo ids.
 * The home runtime's dispatch records are the only place that knows both ends,
 * so the sidebar nests these cards from here instead. Presentation only —
 * removal, base branches and every other lineage rule stay host-local.
 */
export type DelegatedWorktreeEdge = {
  /** Coordinator's worktree, on the runtime that published the edge, so unqualified. */
  parentWorktreeId: string
  childHostId: ExecutionHostId
  childWorktreeId: string
  dispatchId: string
}
