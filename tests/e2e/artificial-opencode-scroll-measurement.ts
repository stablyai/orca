export type ScrollAttemptMeasurement = {
  name: string
  actionMs: number
  observeMs: number
  beforeViewportY: number
  afterActionViewportY: number
  afterViewportY: number
  beforeScrollTop: number | null
  afterActionScrollTop: number | null
  afterScrollTop: number | null
  error?: string
}

export type ResponsiveScrollPath = {
  name: string
  latencyMs: number
}

type ScrollMeasurementLike = {
  scrollLatencyMs: number
  beforeViewportY: number
  afterViewportY: number
  attempts: ScrollAttemptMeasurement[]
}

export function formatScrollAttempts(attempts: ScrollAttemptMeasurement[]): string {
  return attempts
    .map(
      (attempt) =>
        `${attempt.name}:${attempt.beforeViewportY}>${attempt.afterActionViewportY}>${
          attempt.afterViewportY
        }` +
        `(${formatNullableNumber(attempt.beforeScrollTop)}>${formatNullableNumber(
          attempt.afterActionScrollTop
        )}>${formatNullableNumber(
          attempt.afterScrollTop
        )};action=${attempt.actionMs.toFixed(1)};observe=${attempt.observeMs.toFixed(1)})${
          attempt.error ? ':error' : ''
        }`
    )
    .join(',')
}

export function getResponsiveScrollPath(
  measurement: ScrollMeasurementLike
): ResponsiveScrollPath | null {
  let best: ResponsiveScrollPath | null = null
  const recordCandidate = (candidate: ResponsiveScrollPath): void => {
    if (!best || candidate.latencyMs < best.latencyMs) {
      best = candidate
    }
  }

  const cdpWheel = measurement.attempts.find((attempt) => attempt.name === 'cdpWheel')
  if (cdpWheel && cdpWheel.afterViewportY < cdpWheel.beforeViewportY) {
    recordCandidate({
      name: cdpWheel.name,
      latencyMs: measurement.scrollLatencyMs
    })
  }
  for (const attempt of measurement.attempts) {
    if (attempt.name === 'cdpWheel' || attempt.afterViewportY >= attempt.beforeViewportY) {
      continue
    }
    recordCandidate({
      name: attempt.name,
      latencyMs: attempt.actionMs + attempt.observeMs
    })
  }
  return best
}

function formatNullableNumber(value: number | null): string {
  return value === null ? 'na' : value.toFixed(0)
}
