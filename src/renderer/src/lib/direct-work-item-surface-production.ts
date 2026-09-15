import type { AppState } from '@/store'
import type { settleDirectWorkItemStructuredLaunch } from './launch-work-item-direct-agent-routing'
import { getExecutionHostIdForWorktree } from './worktree-runtime-owner'
import {
  registerWorkspaceSurfaceProducer,
  type WorkspaceSurfaceProducer
} from './workspace-surface-production'
import { queueStandaloneSetupTab } from './worktree-setup-issue-command-queue'

type StandaloneSetupArgs = Parameters<typeof queueStandaloneSetupTab>[0]
type StructuredSettlement = Awaited<ReturnType<typeof settleDirectWorkItemStructuredLaunch>>

export function beginDirectWorkItemSurfaceProduction(
  args: Omit<StandaloneSetupArgs, 'store'> & {
    store: AppState
    structuredLaunch: boolean
  }
): { producer: WorkspaceSurfaceProducer | null; setupRunsWithoutPrimary: boolean } {
  const producer = args.structuredLaunch
    ? registerWorkspaceSurfaceProducer({
        workspaceKey: args.worktreeId,
        executionHostId: getExecutionHostIdForWorktree(args.store, args.worktreeId)
      })
    : null
  try {
    const setupRunsWithoutPrimary =
      producer !== null &&
      queueStandaloneSetupTab({
        store: args.store,
        worktreeId: args.worktreeId,
        setup: args.setup,
        issueCommand: args.issueCommand,
        defaultTabs: args.defaultTabs,
        ...(args.opts ? { opts: args.opts } : {})
      })
    return { producer, setupRunsWithoutPrimary }
  } catch (error) {
    producer?.failed(error)
    throw error
  }
}

export function settleDirectWorkItemSurfaceProduction(
  producer: WorkspaceSurfaceProducer,
  result: StructuredSettlement
): void {
  if (result.visibilityUnknown) {
    producer.unverifiable('The execution host may have accepted the agent launch.')
  } else if (result.failed) {
    producer.failed('The agent launch did not publish a surface.')
  } else if (result.structuredSessionId) {
    producer.materialized({ kind: 'tab', id: `agent-session:${result.structuredSessionId}` })
  } else if (result.primaryTabId) {
    producer.materialized({ kind: 'tab', id: result.primaryTabId })
  } else if (result.completed) {
    producer.unverifiable(
      'The agent launch succeeded, but its exact surface identity is unavailable.'
    )
  } else {
    producer.failed('The agent launch fallback did not publish a surface.')
  }
}
