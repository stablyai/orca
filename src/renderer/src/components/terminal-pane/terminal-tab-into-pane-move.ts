import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import type {
  TerminalLeafIntoTabRequest,
  TerminalLeafIntoTabResult
} from '../../../../shared/terminal-leaf-move'
import { layoutContainsLeafId } from '../../../../shared/workspace-layout/terminal-pane-tree'
import { applyTerminalTabJoin } from './terminal-tab-into-pane-apply'
import { resolveTerminalTabIntoPaneEligibility } from './terminal-tab-into-pane-eligibility'
import {
  holdTerminalMoveKeys,
  terminalLeafMoveKey,
  terminalTabMoveKey
} from './terminal-leaf-move-guard'
import type {
  TerminalTabIntoPaneArgs,
  TerminalTabIntoPaneDeps,
  TerminalTabIntoPaneOutcome
} from './terminal-tab-into-pane-types'

function reportMoveFailed(): void {
  toast.error(translate('terminal.paneMove.intoTabFailed', "Couldn't move the pane into that tab."))
}

/** Closes S here without touching its PTY: main already closed it, and T owns the PTY now. */
function closeSourceTab(deps: TerminalTabIntoPaneDeps, sourceTabId: string): void {
  deps.getStore().closeTab(sourceTabId, {
    reason: 'cleanup',
    recordInteraction: false,
    captureRecentlyClosed: false,
    localPtyTeardownOwnedExternally: true
  })
}

/** Main committed but this window could not finish: say so, rebuild T, and drop the ghost source tab. */
function recoverFromFailedApply(
  deps: TerminalTabIntoPaneDeps,
  request: TerminalLeafIntoTabRequest,
  error: unknown
): void {
  console.warn('[terminal-tab-into-pane] applying a committed join failed', error)
  reportMoveFailed()
  try {
    deps.getStore().remountTerminalTabForRecovery(request.targetTabId)
    const sourceStillHere = Object.values(deps.getStore().tabsByWorktree)
      .flat()
      .some((tab) => tab.id === request.sourceTabId)
    if (sourceStillHere) {
      closeSourceTab(deps, request.sourceTabId)
    }
  } catch (recoveryError) {
    console.warn('[terminal-tab-into-pane] recovering from a failed join failed', recoveryError)
  }
}

/** The call never answered, so ask main whether it committed: the leaf is in the target and gone from the source. */
async function settleUnansweredMove(
  deps: TerminalTabIntoPaneDeps,
  request: TerminalLeafIntoTabRequest
): Promise<TerminalLeafIntoTabResult | null> {
  const session = await deps.readMainSession().catch(() => null)
  const layouts = session?.terminalLayoutsByTabId
  const inTarget = layoutContainsLeafId(
    layouts?.[request.targetTabId]?.root ?? null,
    request.leafId
  )
  const inSource = layoutContainsLeafId(
    layouts?.[request.sourceTabId]?.root ?? null,
    request.leafId
  )
  return inTarget && !inSource && request.ptyId
    ? { status: 'moved', ptyId: request.ptyId, sourceTabClosed: true }
    : null
}

/**
 * Joins a single-pane tab into another tab's pane. Main commits first (and closes the source tab in
 * the same write); this window only rolls forward once main says `moved`. A refusal or `not_held`
 * changes nothing here, and a call that never answers is re-settled from main, never refused.
 */
export async function moveTerminalTabIntoPane(
  args: TerminalTabIntoPaneArgs,
  deps: TerminalTabIntoPaneDeps
): Promise<TerminalTabIntoPaneOutcome> {
  const { sourceTabId, targetTabId, side } = args
  const eligibility = resolveTerminalTabIntoPaneEligibility(deps.getStore(), args)
  if (!eligibility.ok) {
    reportMoveFailed()
    return 'refused'
  }
  const { worktreeId, leafId, ptyId, targetLeafId } = eligibility
  // No await sits between the eligibility check and this hold.
  const release = holdTerminalMoveKeys([
    terminalLeafMoveKey(leafId),
    terminalLeafMoveKey(targetLeafId),
    terminalTabMoveKey(sourceTabId),
    terminalTabMoveKey(targetTabId)
  ])
  if (!release) {
    return 'refused'
  }
  try {
    const request: TerminalLeafIntoTabRequest = {
      worktreeId,
      sourceTabId,
      targetTabId,
      targetLeafId,
      leafId,
      ptyId,
      placement: { kind: 'beside', side }
    }
    const answer =
      (await deps.moveLeafIntoTab(request).catch((error: unknown) => {
        console.warn('[terminal-tab-into-pane] main did not answer the move', error)
        return null
      })) ?? (await settleUnansweredMove(deps, request))
    if (answer?.status === 'moved') {
      // Main closed the source in the same write, so every moved result is applied.
      try {
        if (applyTerminalTabJoin(deps, request, answer.ptyId)) {
          return 'moved'
        }
        // T's layout is gone here, so S is only a ghost of a pane main already moved.
        reportMoveFailed()
        closeSourceTab(deps, request.sourceTabId)
      } catch (error) {
        recoverFromFailedApply(deps, request, error)
      }
      return 'unknown'
    }
    reportMoveFailed()
    return answer ? 'refused' : 'unknown'
  } finally {
    release()
  }
}
