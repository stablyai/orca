export function summarize(values) {
  const samples = values.map((value) => round(value)).sort((a, b) => a - b)
  if (samples.length === 0) {
    return { count: 0, median: 0, p95: 0, max: 0, samples }
  }
  return {
    count: samples.length,
    median: percentile(samples, 0.5),
    p95: percentile(samples, 0.95),
    max: samples.at(-1),
    samples
  }
}

function percentile(sorted, fraction) {
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)]
}

export function round(value) {
  return Math.round(value * 100) / 100
}
