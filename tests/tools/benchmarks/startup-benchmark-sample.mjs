export function normalizeStartupBenchmarkOutcome(sample) {
  if (sample.outcome !== 'ok') {
    return sample.outcome
  }
  if (!sample.gracefulShutdownRequested) {
    return 'graceful-shutdown-not-requested'
  }
  if (sample.exitSignal !== null) {
    return 'signal-exit'
  }
  if (sample.exitCode !== 0) {
    return sample.exitCode === null ? 'missing-exit-code' : 'nonzero-exit'
  }
  return 'ok'
}

export function describeInvalidStartupBenchmarkSample(sample) {
  const outcome = normalizeStartupBenchmarkOutcome(sample)
  if (outcome === 'ok') {
    return null
  }
  return `outcome=${outcome}, gracefulShutdownRequested=${String(sample.gracefulShutdownRequested)}, exitCode=${String(sample.exitCode)}, exitSignal=${String(sample.exitSignal)}`
}

export function assertValidStartupBenchmarkSample(sample) {
  const diagnostic = describeInvalidStartupBenchmarkSample(sample)
  if (diagnostic !== null) {
    throw new Error(`Invalid startup benchmark sample: ${diagnostic}`)
  }
}
