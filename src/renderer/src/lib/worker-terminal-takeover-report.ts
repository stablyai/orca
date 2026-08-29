import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'

// Why: one report per pane per window is enough to flip an owned orchestration resource to
// user_owned, but a pane can host a LATER dispatch, so re-report on continued typing instead
// of latching forever.
const REPORT_INTERVAL_MS = 30_000
const REPORT_GATE_PRUNE_SIZE = 256
const REPORT_RETRY_DELAY_MS = 250

const lastReportByPaneKey = new Map<string, number>()

// Fires only from the real-user-input signal (never xterm auto-replies, programmatic prompt
// delivery, resize, or output) and lands on the terminal-owning runtime, where the takeover is
// recorded durably in the orchestration DB.
export function reportWorkerTerminalUserInput(
  paneKey: string,
  runtimeEnvironmentId: string | null
): void {
  const now = Date.now()
  const gateKey = JSON.stringify([runtimeEnvironmentId, paneKey])
  const last = lastReportByPaneKey.get(gateKey)
  if (last !== undefined && now - last < REPORT_INTERVAL_MS) {
    return
  }
  if (lastReportByPaneKey.size >= REPORT_GATE_PRUNE_SIZE) {
    for (const [key, reportedAt] of lastReportByPaneKey) {
      if (now - reportedAt >= REPORT_INTERVAL_MS) {
        lastReportByPaneKey.delete(key)
      }
    }
  }
  lastReportByPaneKey.set(gateKey, now)
  void sendTakeoverReport(paneKey, runtimeEnvironmentId).catch(() => {
    if (lastReportByPaneKey.get(gateKey) === now) {
      lastReportByPaneKey.delete(gateKey)
    }
  })
}

async function sendTakeoverReport(
  paneKey: string,
  runtimeEnvironmentId: string | null
): Promise<void> {
  const target =
    runtimeEnvironmentId !== null
      ? ({ kind: 'environment', environmentId: runtimeEnvironmentId } as const)
      : ({ kind: 'local' } as const)
  const report = () =>
    callRuntimeRpc(
      target,
      'orchestration.workerTerminalUserInput',
      { paneKey },
      { suppressFeatureInteraction: true, reuseRecentCompatibilityFailure: true }
    )
  try {
    await report()
  } catch {
    await new Promise<void>((resolve) => setTimeout(resolve, REPORT_RETRY_DELAY_MS))
    await report()
  }
}
