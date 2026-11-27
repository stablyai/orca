import { useAppStore } from '@/store'
import { normalizePromptField } from '../../../../../../shared/agent-status/contracts/agent-status-field-normalization'
import { makePaneKey } from '../../../../../../shared/workspace-layout/stable-pane-id'

type TerminalHandoffSubmission = {
  tabId: string
  leafId: string
  ptyId: string
  startedAt: number
  prompt: string
  signal: AbortSignal
}

/** Wait for Codex's UserPromptSubmit on the pane that received this handoff. */
export function waitForTerminalHandoffSubmission({
  tabId,
  leafId,
  ptyId,
  startedAt,
  prompt,
  signal
}: TerminalHandoffSubmission): Promise<boolean> {
  const paneKey = makePaneKey(tabId, leafId)
  const preview = normalizePromptField(prompt)
  if (signal.aborted || !preview) {
    return Promise.resolve(false)
  }
  return new Promise<boolean>((resolve) => {
    const finish = (confirmed: boolean): void => {
      window.clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      unsubscribe()
      resolve(confirmed)
    }
    const onAbort = (): void => finish(false)
    const observe = (state: ReturnType<typeof useAppStore.getState>): void => {
      const boundPty = state.terminalLayoutsByTabId[tabId]?.ptyIdsByLeafId?.[leafId]
      if (boundPty !== undefined && boundPty !== ptyId) {
        finish(false)
        return
      }
      const status = state.agentStatusByPaneKey.get(paneKey)
      const evidence = status?.observation
      if (
        boundPty === ptyId &&
        status?.agentType === 'codex' &&
        !status.restoredUnconfirmed &&
        evidence?.origin === 'hook' &&
        evidence.kind === 'transition' &&
        evidence.boundary === true &&
        evidence.observedAt >= startedAt &&
        status.prompt === preview
      ) {
        finish(true)
      }
    }
    // Start at PTY admission, so quick submissions can be seen before the paste promise resolves.
    const timer = window.setTimeout(onAbort, 30_000)
    const unsubscribe = useAppStore.subscribe(observe)
    signal.addEventListener('abort', onAbort, { once: true })
    observe(useAppStore.getState())
  })
}
