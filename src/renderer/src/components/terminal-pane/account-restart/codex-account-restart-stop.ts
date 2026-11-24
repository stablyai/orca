import { useAppStore } from '@/store/index'
import { createNonSecureContextUuid as createBrowserUuid } from '../../../../../shared/identifiers/non-secure-context-uuid'
import type {
  CodexAccountRestartStopRequest,
  CodexAccountRestartStopResult
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
  if (
    result.outcome === 'not-started' &&
    (result.reason === 'unsupported' || result.reason === 'invalid')
  ) {
    return 'fallback'
  }
  const store = useAppStore.getState()
  if (result.outcome === 'stopped') {
    // The exit arrives as a restart exit; the pane's normal resume picks up the selected account.
    store.clearCodexRestartNotice(pane.ptyId)
  } else {
    store.reopenCodexRestartPrompt(pane.ptyId)
  }
  return 'handled'
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

export const _testing = {
  setOpIdMinter(minter: () => string): void {
    mintOpId = minter
  },
  reset(): void {
    currentOperationByPtyId.clear()
    mintOpId = () => createBrowserUuid()
  }
}
