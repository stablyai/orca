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

/** Capture remote panes before each park: host capability does not prove retained bytes, and unavailable is not empty. Mutate the caller-owned episode ledger; ordinary bytes remain local (docs/reference/ssh-execution-boundary.md). */
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
  // On unhydrated catalogs, over-capture remote candidates; skipping risks no surviving copy (opposite default to worktree-runtime-owner.ts).
  const repos = useAppStore.getState().repos ?? []
  const pending: Promise<unknown>[] = []
  for (const tabId of parkedTabIds) {
    if (capturedTabIds.has(tabId)) {
      continue
    }
    // Capture one tab so incomplete coverage leaves just that tab unmarked for retry.
    // Every-hide captures stay client-local to avoid uploading ordinary park bytes.
    enqueueParkedTerminalCapture(
      captureParkedTerminalBuffers({ worktreeId, tabIds: [tabId], repos, localOnly: true }),
      () => {
        // A reveal during the yield must not mark the tab captured, or the next park skips the fresh serialize.
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
