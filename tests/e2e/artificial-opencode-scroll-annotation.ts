import type { TestInfo } from '@stablyai/playwright-test'
import {
  formatScrollAttempts,
  getResponsiveScrollPath,
  type ScrollAttemptMeasurement
} from './artificial-opencode-scroll-measurement'

type ScrollMeasurementForAnnotation = {
  scrollLatencyMs: number
  maxTimerDriftMs: number
  beforeViewportY: number
  afterViewportY: number
  baseY: number
  attempts: ScrollAttemptMeasurement[]
}

type ScrollMainPressureSnapshot = {
  peakPendingChars: number
  peakRendererInFlightChars: number
  ackGatedFlushSkipCount: number
}

type ScrollAckGateSnapshot = {
  heldAckChars: number
  heldAckCount: number
  gatedPtyCount: number
}

export function annotateScrollMeasurement(
  testInfo: TestInfo,
  type: string,
  paneCount: number,
  measurement: ScrollMeasurementForAnnotation,
  mainPressure: ScrollMainPressureSnapshot | null,
  ackGate: ScrollAckGateSnapshot | null
): void {
  const scrollMoved = measurement.afterViewportY < measurement.beforeViewportY
  const responsiveScroll = getResponsiveScrollPath(measurement)
  const scrollMetric = responsiveScroll
    ? ` scroll=${responsiveScroll.latencyMs.toFixed(1)}ms scrollPath=${responsiveScroll.name}${
        responsiveScroll.name === 'cdpWheel'
          ? ''
          : ` cdpScroll=${measurement.scrollLatencyMs.toFixed(1)}ms`
      }`
    : ''
  const attempts = formatScrollAttempts(measurement.attempts)
  testInfo.annotations.push({
    type,
    description: `panes=${paneCount}${scrollMetric} scrollMoved=${scrollMoved} maxTimerDrift=${measurement.maxTimerDriftMs.toFixed(
      1
    )}ms viewportBefore=${measurement.beforeViewportY} viewportAfter=${
      measurement.afterViewportY
    } baseY=${measurement.baseY} scrollAttempts=${attempts} mainPeakPendingChars=${
      mainPressure?.peakPendingChars ?? 0
    } mainPeakInFlightChars=${mainPressure?.peakRendererInFlightChars ?? 0} mainAckGatedFlushSkips=${
      mainPressure?.ackGatedFlushSkipCount ?? 0
    } heldAckPtys=${ackGate?.heldAckCount ?? 0} heldAckChars=${
      ackGate?.heldAckChars ?? 0
    } gatedAckPtys=${ackGate?.gatedPtyCount ?? 0}`
  })
}
