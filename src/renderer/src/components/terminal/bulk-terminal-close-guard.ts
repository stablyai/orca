import { useAppStore } from '@/store'
import { inspectRuntimeTerminalProcess } from '@/runtime/runtime-terminal-inspection'
import { resolvePinnedTabLabel } from '@/store/pinned-tab-close-guard'
import { useRunningTerminalCloseConfirmStore } from '@/store/running-terminal-close-confirm'
import type { AppState } from '@/store/types'
import { collectTabPtyIds, RUNNING_CLOSE_PROBE_TIMEOUT_MS } from './running-terminal-close-guard'
import { resolveBusyPtyCloseCopyKind } from './terminal-close-copy-kind'

/** A terminal tab in the bulk set, with the PTYs it could still own. */
type BulkCloseCandidate = { terminalTabId: string; ptyIds: string[] }

type BulkCloseTabState = Pick<AppState, 'unifiedTabsByWorktree' | 'tabsByWorktree'>

/**
 * Terminal tab ids (entity ids) inside a mixed tab-strip id list, skipping the pinned tabs
 * a bulk close leaves alone. Accepts either unified-tab ids or entity ids because the tab
 * strip emits entity ids for terminals and unified ids for editors.
 */
export function collectBulkTerminalTabIds(
  state: BulkCloseTabState,
  worktreeId: string,
  visibleIds: readonly string[]
): string[] {
  const unifiedTabs = state.unifiedTabsByWorktree?.[worktreeId] ?? []
  const terminalTabIds: string[] = []
  for (const visibleId of visibleIds) {
    const unifiedTab = unifiedTabs.find(
      (candidate) => candidate.id === visibleId || candidate.entityId === visibleId
    )
    if (unifiedTab) {
      if (unifiedTab.contentType === 'terminal' && unifiedTab.isPinned !== true) {
        terminalTabIds.push(unifiedTab.entityId)
      }
      continue
    }
    // Why: agent quick-launch can briefly leave a terminal in the runtime store before its
    // unified row lands; missing it here would silently drop the prompt for a busy tab.
    if ((state.tabsByWorktree?.[worktreeId] ?? []).some((tab) => tab.id === visibleId)) {
      terminalTabIds.push(visibleId)
    }
  }
  return terminalTabIds
}

function terminalTabStillOpen(
  state: BulkCloseTabState,
  worktreeId: string,
  terminalTabId: string
): boolean {
  return (
    (state.tabsByWorktree?.[worktreeId] ?? []).some((tab) => tab.id === terminalTabId) ||
    (state.unifiedTabsByWorktree?.[worktreeId] ?? []).some(
      (tab) => tab.contentType === 'terminal' && tab.entityId === terminalTabId
    )
  )
}

/**
 * Routes "Close Others" / "Close Tabs To The Right" / "Close Tabs To The Left" / "Close
 * split pane" through the running-process confirmation those paths used to skip outright.
 *
 * Shape follows the unsaved-editor close flow: walk the busy tabs in strip order, jump to
 * each one so the prompt names something the user is looking at, and ask about it on its
 * own. Nothing closes until every prompt is answered — cancelling any one of them abandons
 * the whole bulk close, so the user never ends up with a half-applied close they cannot
 * undo. A set with nothing running never asks and stays fully synchronous.
 */
export function guardBulkTerminalClose(params: {
  worktreeId: string
  terminalTabIds: readonly string[]
  /** Reveals a tab before its prompt. Omitted by surfaces that cannot activate a tab. */
  revealTab?: (terminalTabId: string) => void
  onProceed: () => void
  onCancel?: () => void
}): void {
  const { worktreeId, terminalTabIds, revealTab, onProceed, onCancel } = params
  const state = useAppStore.getState()
  const settings = state.settings
  const candidates: BulkCloseCandidate[] = []
  for (const terminalTabId of new Set(terminalTabIds)) {
    const ptyIds = collectTabPtyIds(state, terminalTabId)
    if (ptyIds.length > 0) {
      candidates.push({ terminalTabId, ptyIds })
    }
  }
  // Why: nothing to probe (parked/hibernated tabs, or a set with no terminals at all) and
  // the opt-out setting both mean the answer is known, so the close stays synchronous.
  if (candidates.length === 0 || settings?.skipCloseTerminalWithRunningProcessConfirm === true) {
    onProceed()
    return
  }

  // Why: the timeout, the probe result and the error path race to decide this close, so the
  // first one to land owns it instead of trusting those races to stay mutually exclusive.
  let decided = false
  const proceedNow = (): void => {
    if (decided) {
      return
    }
    decided = true
    onProceed()
  }

  /** Asks about one busy tab at a time; the whole close waits on the last answer. */
  const askInTurn = (queue: readonly BulkCloseCandidate[], index: number): void => {
    const candidate = queue[index]
    if (!candidate) {
      onProceed()
      return
    }
    const latest = useAppStore.getState()
    // Why: an earlier prompt can sit open long enough for this tab to exit on its own, and
    // asking to stop a tab the user can no longer see would be nonsense.
    if (!terminalTabStillOpen(latest, worktreeId, candidate.terminalTabId)) {
      askInTurn(queue, index + 1)
      return
    }
    // Why: jump to the tab first so the prompt is about the pane in front of the user
    // rather than one somewhere off in the strip.
    revealTab?.(candidate.terminalTabId)
    useRunningTerminalCloseConfirmStore.getState().requestRunningTerminalCloseConfirm({
      terminalTabId: candidate.terminalTabId,
      tabLabel: resolvePinnedTabLabel(latest, worktreeId, candidate.terminalTabId),
      copyKind: resolveBusyPtyCloseCopyKind(candidate.terminalTabId, candidate.ptyIds),
      onConfirm: ({ dontAskAgain }) => {
        // Why: the user opted out part-way through the set, so close the rest outright
        // instead of raising the prompt they just dismissed for good.
        if (dontAskAgain) {
          onProceed()
          return
        }
        askInTurn(queue, index + 1)
      },
      // Why: one cancel abandons the entire bulk close. Closing the tabs already approved
      // would leave a partial result the user cannot undo, so nothing closes at all.
      onCancel: () => onCancel?.()
    })
  }

  const startAsking = (busy: readonly BulkCloseCandidate[]): void => {
    if (decided) {
      return
    }
    decided = true
    askInTurn(busy, 0)
  }

  const probes = candidates.flatMap((candidate) =>
    candidate.ptyIds.map((ptyId) => ({ candidate, ptyId }))
  )
  const probeTimeout = setTimeout(() => {
    try {
      // Why: a probe that has not answered yet is unknown, not idle. Ask about every
      // candidate so a degraded relay costs clicks instead of killed remote work.
      startAsking(candidates)
    } catch {
      proceedNow()
    }
  }, RUNNING_CLOSE_PROBE_TIMEOUT_MS)

  void Promise.allSettled(probes.map(({ ptyId }) => inspectRuntimeTerminalProcess(settings, ptyId)))
    .then((results) => {
      clearTimeout(probeTimeout)
      if (decided) {
        return
      }
      // Why: fail open on an *answered* probe, matching the single-tab guard — a rejection
      // or a stale remote handle is not evidence of a live child, and a menu action that
      // silently does nothing is worse than closing a busy tab.
      const busyPtyIdsByTabId = new Map<string, string[]>()
      results.forEach((result, index) => {
        if (
          result.status !== 'fulfilled' ||
          !result.value.hasChildProcesses ||
          result.value.unavailable === true
        ) {
          return
        }
        const probe = probes[index]!
        const busyPtyIds = busyPtyIdsByTabId.get(probe.candidate.terminalTabId)
        if (busyPtyIds) {
          busyPtyIds.push(probe.ptyId)
        } else {
          busyPtyIdsByTabId.set(probe.candidate.terminalTabId, [probe.ptyId])
        }
      })
      if (busyPtyIdsByTabId.size === 0) {
        proceedNow()
        return
      }
      // Why: walk `candidates` rather than the map so the prompts arrive in strip order.
      startAsking(
        candidates
          .filter((candidate) => busyPtyIdsByTabId.has(candidate.terminalTabId))
          .map((candidate) => ({
            terminalTabId: candidate.terminalTabId,
            ptyIds: busyPtyIdsByTabId.get(candidate.terminalTabId)!
          }))
      )
    })
    // Why: allSettled never rejects, so this only fires when the decision above throws (a
    // label lookup, a store subscriber). Without it the bulk close would silently never
    // happen and the user would get no feedback at all.
    .catch(() => {
      clearTimeout(probeTimeout)
      proceedNow()
    })
}
