import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'

// Throttle one takeover/pane/window, but report continued typing again because later dispatches can reuse that pane.
const REPORT_INTERVAL_MS = 30_000
const REPORT_GATE_PRUNE_SIZE = 256
const REPORT_RETRY_DELAY_MS = 250

const lastReportByPaneKey = new Map<string, number>()

/** Only real user input signals durable takeover on the terminal owner; exclude replies, prompt delivery, resize and output. */
export function reportWorkerTerminalUserInput(
  paneKey: string,
  runtimeEnvironmentId: string | null
): void {
  reportTakeover({ paneKey }, runtimeEnvironmentId)
}

/** Address structured workers by session, never secret pane key. The owning runtime resolves its credential; exposing it to renderer would let chat observers learn it. */
export function reportStructuredSessionUserInput(
  sessionId: string,
  runtimeEnvironmentId: string | null
): void {
  reportTakeover({ sessionId }, runtimeEnvironmentId)
}

function reportTakeover(
  subject: { paneKey: string } | { sessionId: string },
  runtimeEnvironmentId: string | null
): void {
  const now = Date.now()
  const gateKey = JSON.stringify([runtimeEnvironmentId, subject])
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
  void sendTakeoverReport(subject, runtimeEnvironmentId).catch(() => {
    if (lastReportByPaneKey.get(gateKey) === now) {
      lastReportByPaneKey.delete(gateKey)
    }
  })
}

async function sendTakeoverReport(
  subject: { paneKey: string } | { sessionId: string },
  runtimeEnvironmentId: string | null
): Promise<void> {
  const target =
    runtimeEnvironmentId !== null
      ? ({ kind: 'environment', environmentId: runtimeEnvironmentId } as const)
      : ({ kind: 'local' } as const)
  const report = () =>
    callRuntimeRpc(target, 'orchestration.workerTerminalUserInput', subject, {
      suppressFeatureInteraction: true,
      reuseRecentCompatibilityFailure: true
    })
  try {
    await report()
  } catch {
    await new Promise<void>((resolve) => setTimeout(resolve, REPORT_RETRY_DELAY_MS))
    await report()
  }
}
