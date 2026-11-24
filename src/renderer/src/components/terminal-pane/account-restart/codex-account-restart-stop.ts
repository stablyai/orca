import { useAppStore } from '@/store/index'
import { createNonSecureContextUuid as createBrowserUuid } from '../../../../../shared/identifiers/non-secure-context-uuid'
import {
  CODEX_ACCOUNT_RESTART_RESUME_ERROR,
  type CodexAccountRestartPane,
  type CodexAccountRestartNotStartedReason,
  type CodexAccountRestartStopRequest,
  type CodexAccountRestartStopResult
} from '../../../../../shared/agent-accounts/codex/codex-account-restart-stop'

type CodexRestartPane = Omit<CodexAccountRestartStopRequest, 'opId'>

type CodexRestartOperation = CodexAccountRestartStopRequest & {
  /** The notice generation the user answered; any other generation is a different question. */
  generation: number | undefined
}

// The notice row's current operation; a reply or Dismiss for any other opId changes nothing.
const currentOperationByPtyId = new Map<string, CodexRestartOperation>()
let stopWatchingNotices: (() => void) | null = null

let mintOpId = (): string => createBrowserUuid()

/** `fallback`: main cannot stop this lane, so the caller keeps its replacement restart. */
export async function stopCodexPaneForAccountRestart(
  pane: CodexRestartPane
): Promise<'handled' | 'fallback'> {
  const operation = { ...pane, opId: mintOpId(), generation: noticeGenerationOf(pane.ptyId) }
  currentOperationByPtyId.set(pane.ptyId, operation)
  watchNoticeGenerations()
  let result: CodexAccountRestartStopResult
  try {
    result = await window.api.pty.stopCodexForAccountRestart(toRequest(operation))
  } catch {
    result = { outcome: 'unknown', opIds: [operation.opId] }
  }
  const current = currentOperationByPtyId.get(pane.ptyId)
  // A joined click shares the stop, so its opId is in the reply too; Dismiss or a newer question
  // removed the row's operation, and its own answer settles that newer notice.
  if (!current || !result.opIds.includes(current.opId)) {
    return 'handled'
  }
  forgetOperation(pane.ptyId)
  const store = useAppStore.getState()
  // Only lanes main does not stop locally (SSH, paired runtime) keep the replacement restart.
  if (result.outcome === 'not-started' && result.reason === 'unsupported') {
    return 'fallback'
  }
  if (result.outcome === 'stopped') {
    // The exit arrives as a restart exit; the pane's normal resume picks up the selected account.
    store.clearCodexRestartNotice(pane.ptyId)
  } else if (requiresManualRestart(result)) {
    // A route Orca cannot stop and resume safely: the user switches by restarting Codex themselves.
    store.reopenCodexRestartPrompt(pane.ptyId, 'manual')
  } else {
    store.reopenCodexRestartPrompt(pane.ptyId)
  }
  return 'handled'
}

const MANUAL_REASONS: ReadonlySet<CodexAccountRestartNotStartedReason> = new Set([
  'service-outdated',
  'resume-unavailable',
  'no-session',
  'refused',
  'invalid'
])

function requiresManualRestart(result: CodexAccountRestartStopResult): boolean {
  // `unknown`: the stop may have run without proof, so the resume stayed on the old account.
  return (
    result.outcome === 'unknown' ||
    (result.outcome === 'not-started' && MANUAL_REASONS.has(result.reason))
  )
}

function noticeGenerationOf(ptyId: string): number | undefined {
  return useAppStore.getState().codexRestartNoticeByPtyId?.[ptyId]?.generation
}

function toRequest(operation: CodexRestartOperation): CodexAccountRestartStopRequest {
  const { generation: _generation, ...request } = operation
  return request
}

function forgetOperation(ptyId: string): void {
  currentOperationByPtyId.delete(ptyId)
  if (currentOperationByPtyId.size === 0) {
    stopWatchingNotices?.()
    stopWatchingNotices = null
  }
}

/**
 * A prompt that changed target, or went away while its process is still in the pane (the user chose
 * the launch account again), withdraws the answer given to it, in main too. The accepted stop's own
 * exit unbinds the process from the pane and removes the notice; that is not a withdrawal.
 */
function watchNoticeGenerations(): void {
  stopWatchingNotices ??= useAppStore.subscribe(() => {
    const state = useAppStore.getState()
    for (const [ptyId, operation] of currentOperationByPtyId) {
      const generation = noticeGenerationOf(ptyId)
      const retargeted = generation !== undefined && generation !== operation.generation
      const clearedWhileRunning =
        generation === undefined && (state.ptyIdsByTabId?.[operation.tabId] ?? []).includes(ptyId)
      if (retargeted || clearedWhileRunning) {
        withdrawCodexPaneAccountRestart(ptyId)
      }
    }
  })
}

/** Dismiss during a stop: the stop in flight still settles, but its resume stays on the old account. */
export function withdrawCodexPaneAccountRestart(ptyId: string): void {
  const current = currentOperationByPtyId.get(ptyId)
  if (!current) {
    return
  }
  forgetOperation(ptyId)
  const { ptyId: _ptyId, generation: _generation, ...withdraw } = current
  void window.api.pty.withdrawCodexAccountRestart(withdraw).catch((err: unknown) => {
    console.warn('[codex-restart] failed to withdraw account restart:', err)
  })
}

/** Dismissing the failed resume is the user's choice to let the pane start normally again. */
export function releaseCodexAccountRestartRefusal(
  error: string,
  ...[worktreeId, tabId, leafId]: [string, string, string]
): void {
  if (!error.includes(CODEX_ACCOUNT_RESTART_RESUME_ERROR)) {
    return
  }
  const pane: CodexAccountRestartPane = { worktreeId, tabId, leafId }
  void window.api.pty.releaseCodexAccountRestartPane(pane).catch((err: unknown) => {
    console.warn('[codex-restart] failed to release the refused pane:', err)
  })
}

export const _testing = {
  setOpIdMinter(minter: () => string): void {
    mintOpId = minter
  },
  reset(): void {
    currentOperationByPtyId.clear()
    stopWatchingNotices?.()
    stopWatchingNotices = null
    mintOpId = () => createBrowserUuid()
  }
}
