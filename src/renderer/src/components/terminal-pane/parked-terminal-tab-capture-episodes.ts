import { useAppStore } from '../../store'
import {
  beginParkedCapturePass,
  captureParkedTerminalBuffers,
  enqueueParkedTerminalCapture,
  whenParkedCaptureSettles
} from './parked-terminal-buffer-capture'
import { haveSameTerminalTabIds } from './use-terminal-park-verdict-pin'

const capturedTabIdsByWorktree = new Map<string, Set<string>>()
const captureEpisodeGenerationByWorktree = new Map<string, { current: number }>()
const latestParkedTabIdsByWorktree = new Map<string, ReadonlySet<string>>()

function captureEpisodeGeneration(worktreeId: string): { current: number } {
  let generation = captureEpisodeGenerationByWorktree.get(worktreeId)
  if (!generation) {
    generation = { current: 0 }
    captureEpisodeGenerationByWorktree.set(worktreeId, generation)
  }
  return generation
}

/** @internal */
export function resetParkedTerminalTabCaptureEpisodesForTesting(): void {
  capturedTabIdsByWorktree.clear()
  captureEpisodeGenerationByWorktree.clear()
  latestParkedTabIdsByWorktree.clear()
}

export type CaptureNewlyParkedTerminalTabsOptions = {
  isTabStillParked?: (tabId: string) => boolean
  isCurrent?: () => boolean
}

/** Serialize each newly parked tab's panes while they are still mounted, once per park episode.
 *  Why here rather than at unmount: a remote-runtime tab's xterm is the only client-side copy of
 *  its scrollback. `capturedTabIds` is mutated in place: it is the caller's ref-held episode ledger.
 *  Returns a Promise only when a registered remote pane still has to yield. */
export function captureNewlyParkedTerminalTabs(
  worktreeId: string,
  parkedTabIds: ReadonlySet<string>,
  capturedTabIds: Set<string>,
  options?: CaptureNewlyParkedTerminalTabsOptions
): void | Promise<void> {
  const isTabStillParked = options?.isTabStillParked ?? ((tabId) => parkedTabIds.has(tabId))
  for (const tabId of Array.from(capturedTabIds)) {
    if (!parkedTabIds.has(tabId)) {
      capturedTabIds.delete(tabId)
    }
  }
  if (capturedTabIds.size === parkedTabIds.size) {
    return
  }
  // Why the fallback: capture is best-effort evidence and must never throw out of the park pass.
  // An unhydrated catalog fails open toward "remote" in shouldPreserveTerminalScrollbackBuffers.
  const repos = useAppStore.getState().repos ?? []
  const pending: Promise<unknown>[] = []
  for (const tabId of parkedTabIds) {
    if (capturedTabIds.has(tabId)) {
      continue
    }
    // Why one tab per call: coverage is reported for the whole batch, and a tab mid-remount must
    // stay unmarked so the next pass retries it instead of parking it uncaptured.
    enqueueParkedTerminalCapture(
      captureParkedTerminalBuffers({
        worktreeId,
        tabIds: [tabId],
        repos
      }),
      () => {
        // Why re-check: a reveal during the yield must not mark the tab captured, or the next
        // park early-returns and skips the fresh serialize the replay just dropped.
        if (!isTabStillParked(tabId)) {
          return
        }
        capturedTabIds.add(tabId)
      },
      pending,
      options?.isCurrent
    )
  }
  if (pending.length === 0) {
    return
  }
  return Promise.all(pending).then(() => undefined)
}

export function scheduleNewlyParkedTerminalTabCapture(
  worktreeId: string,
  parkedTabIds: ReadonlySet<string>,
  parkedTabIdsRef: { current: ReadonlySet<string> },
  setParkedTabIds: (ids: ReadonlySet<string>) => void
): void {
  let capturedTabIds = capturedTabIdsByWorktree.get(worktreeId)
  if (!capturedTabIds) {
    capturedTabIds = new Set()
    capturedTabIdsByWorktree.set(worktreeId, capturedTabIds)
  }
  latestParkedTabIdsByWorktree.set(worktreeId, parkedTabIds)
  const pass = beginParkedCapturePass(captureEpisodeGeneration(worktreeId))
  whenParkedCaptureSettles(
    captureNewlyParkedTerminalTabs(worktreeId, parkedTabIds, capturedTabIds, {
      isTabStillParked: (tabId) =>
        latestParkedTabIdsByWorktree.get(worktreeId)?.has(tabId) === true,
      isCurrent: pass.isCurrent
    }),
    () => {
      if (!haveSameTerminalTabIds(parkedTabIdsRef.current, parkedTabIds)) {
        parkedTabIdsRef.current = parkedTabIds
        setParkedTabIds(parkedTabIds)
      }
    },
    pass.isCurrent
  )
}
