import { useAppStore } from '../../store'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'
import { isFrameDrawnServerWorkspace } from './frame-drawn-server-workspaces'
import { isWebRuntimeInitialTerminalBootstrapInFlight } from '../web-runtime-initial-terminal-bootstrap'
import { dispatchWebRuntimeInitialTerminalBootstrap } from '../web-runtime-initial-terminal-bootstrap-dispatch'
import { shouldApplyRecoveredWebSessionTabsSnapshot } from './tracking'
import { shouldBootstrapInitialWebRuntimeTerminal } from './tracking-decisions'
import type { RuntimeMobileSessionTabsResult } from '../../../../shared/runtime-types'
import type { SessionTabsStreamEvent } from './state'

type SessionTabsFrame = RuntimeMobileSessionTabsResult & { type: 'snapshot' | 'updated' }

type DeferredSeed = {
  event: SessionTabsFrame
  firstHostAnswer: boolean
  receivedFrame: number
  runtimeId: string | undefined
}

export type InitialTerminalSeeder = {
  /** Whether an applied, fresh frame asks for the worktree's first terminal. */
  decide: (event: SessionTabsStreamEvent, firstHostAnswer: boolean) => boolean
  /** Records the latest applied frame's verdict; only an unselected worktree keeps it pending. */
  noteAppliedFrame: (seed: DeferredSeed | null, selected: boolean) => void
  seed: () => Promise<void>
  /** The worktree was selected again on a warm stream that never re-sends its answer. */
  reconsiderSelected: (selected: boolean) => void
  dispose: () => void
}

export function createInitialTerminalSeeder(
  environmentId: string,
  worktreeId: string
): InitialTerminalSeeder {
  let requestedInitialTerminal = false
  let deferred: DeferredSeed | null = null
  let disposed = false

  const decide = (event: SessionTabsStreamEvent, firstHostAnswer: boolean): boolean => {
    // Switch point: ORCA_LAYOUT_OWNER_IS_MAIN && — a frame-drawn workspace's tabs are not the mirror's to create.
    // Interim (ledger L240): seeding stays only for servers without `layout.intents.v1`, until Phase 2.
    if (ORCA_LAYOUT_OWNER_IS_MAIN && isFrameDrawnServerWorkspace(environmentId, worktreeId)) {
      return false
    }
    const state = useAppStore.getState()
    return shouldBootstrapInitialWebRuntimeTerminal({
      event,
      activeWorktreeId: worktreeId,
      // Closure guard prevents reseeding after its successful create; failed creates leave it retryable. Shared latch survives effect reinstall so fresh closures cannot duplicate pending creates (STA-6173).
      requestedInitialTerminal:
        requestedInitialTerminal ||
        isWebRuntimeInitialTerminalBootstrapInFlight(environmentId, worktreeId),
      snapshotIsFresh: true,
      localTerminalCount: (state.tabsByWorktree[worktreeId] ?? []).length,
      hasPersistedTerminalState: Object.hasOwn(state.tabsByWorktree, worktreeId),
      firstHostAnswer
    })
  }

  const seed = async (): Promise<void> => {
    if (await dispatchWebRuntimeInitialTerminalBootstrap(environmentId, worktreeId)) {
      requestedInitialTerminal = true
    }
  }

  return {
    decide,
    noteAppliedFrame: (next, selected) => {
      deferred = next && !selected ? next : null
    },
    seed,
    reconsiderSelected: (selected) => {
      const pending = deferred
      if (disposed || !pending || !selected) {
        return
      }
      deferred = null
      // Why: newer evidence (often via the all-worktrees stream) supersedes the held empty answer.
      if (
        !shouldApplyRecoveredWebSessionTabsSnapshot(
          environmentId,
          pending.event,
          pending.receivedFrame,
          pending.runtimeId
        )
      ) {
        return
      }
      // Why re-decide: local tabs or another closure's create may have filled the worktree since.
      if (!decide(pending.event, pending.firstHostAnswer)) {
        return
      }
      void seed().catch((error) => {
        console.warn('[web-session-tabs-sync] deferred initial terminal failed:', error)
      })
    },
    dispose: () => {
      disposed = true
      deferred = null
    }
  }
}
