import type { Page } from '@stablyai/playwright-test'
import { waitForMarkerLatency } from './artificial-opencode-pane-interactions'
import {
  measureTerminalOperationLatency,
  type TerminalLatencyMeasurement
} from './artificial-opencode-terminal-latency-measurement'
import { switchToWorktree } from './helpers/store'

export async function measureHiddenOutputRestoreLatency(
  page: Page,
  worktreeId: string,
  runId: string
): Promise<TerminalLatencyMeasurement> {
  return measureTerminalOperationLatency(page, async () => {
    await switchToWorktree(page, worktreeId)
    await waitForMarkerLatency(page, `OPENCODE_PRESSURE_DONE_${runId}_`, 20_000)
  })
}

function formatOptionalMetric(value: number | null, suffix: string): string {
  return value == null ? 'na' : `${value.toFixed(1)}${suffix}`
}

export function describeHiddenOutputRestoreMeasurement({
  paneCount,
  measurement,
  hiddenDeliveryDroppedChars,
  mainPeakInFlightChars,
  heldAckChars
}: {
  paneCount: number
  measurement: TerminalLatencyMeasurement
  hiddenDeliveryDroppedChars: number
  mainPeakInFlightChars: number
  heldAckChars: number
}): string {
  return `panes=${paneCount} restore=${measurement.elapsedMs.toFixed(
    1
  )}ms restoreRendererDrift=${measurement.maxTimerDriftMs.toFixed(
    1
  )}ms restoreControllerDrift=${measurement.controllerMaxTimerDriftMs.toFixed(
    1
  )}ms restoreRendererLongTask=${measurement.rendererMaxLongTaskMs.toFixed(
    1
  )}ms restoreLongTaskSupported=${
    measurement.rendererLongTaskSupported
  } restoreRendererTask=${formatOptionalMetric(
    measurement.rendererTaskDurationMs,
    'ms'
  )} restoreRendererScript=${formatOptionalMetric(
    measurement.rendererScriptDurationMs,
    'ms'
  )} restoreHostCpuBusy=${formatOptionalMetric(
    measurement.hostCpuBusyPercent,
    '%'
  )} restoreHostCpuPressureWait=${formatOptionalMetric(
    measurement.hostCpuPressureWaitMs,
    'ms'
  )} hiddenDeliveryDroppedChars=${hiddenDeliveryDroppedChars} mainPeakInFlightChars=${mainPeakInFlightChars} heldAckChars=${heldAckChars}`
}
