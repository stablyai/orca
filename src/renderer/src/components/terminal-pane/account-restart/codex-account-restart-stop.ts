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

// The notice row's current operation; a reply or Dismiss for any other opId changes nothing.
const currentOperationByPtyId = new Map<string, CodexAccountRestartStopRequest>()

let mintOpId = (): string => createBrowserUuid()

/** `fallback`: main cannot stop this lane, so the caller keeps its replacement restart. */
export async function stopCodexPaneForAccountRestart(
  pane: CodexRestartPane
): Promise<'handled' | 'fallback'> {
  const operation = { ...pane, opId: mintOpId() }
  currentOperationByPtyId.set(pane.ptyId, operation)
  // The notice's target names its generation: a newer switch must get its own answer.
  const noticeTarget = noticeTargetOf(pane.ptyId)
  let result: CodexAccountRestartStopResult
  try {
    result = await window.api.pty.stopCodexForAccountRestart(operation)
  } catch {
    result = { outcome: 'unknown', opIds: [operation.opId] }
  }
  const current = currentOperationByPtyId.get(pane.ptyId)
  // A joined click shares the stop, so its opId is in the reply too; Dismiss removed the row's operation.
  if (!current || !result.opIds.includes(current.opId)) {
    return 'handled'
  }
  currentOperationByPtyId.delete(pane.ptyId)
  const store = useAppStore.getState()
  if (noticeTargetOf(pane.ptyId) !== noticeTarget && result.outcome !== 'stopped') {
    // The notice moved to a newer switch while this request ran: settle it by asking again, so the
    // current prompt is visible and input is not left blocked; never act on it automatically.
    store.reopenCodexRestartPrompt(pane.ptyId)
    return 'handled'
  }
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

function noticeTargetOf(ptyId: string): string | null | undefined {
  return useAppStore.getState().codexRestartNoticeByPtyId?.[ptyId]?.nextAccountId
}

/** Dismiss during a stop: the stop in flight still settles, but its resume stays on the old account. */
export function withdrawCodexPaneAccountRestart(ptyId: string): void {
  const current = currentOperationByPtyId.get(ptyId)
  if (!current) {
    return
  }
  currentOperationByPtyId.delete(ptyId)
  const { ptyId: _ptyId, ...withdraw } = current
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
    mintOpId = () => createBrowserUuid()
  }
}
