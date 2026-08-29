export function assertForegroundProbeSucceeded(probe, label) {
  const failures = probe.results.filter(
    (result) => result.error || typeof result.foreground !== 'string' || !result.foreground.trim()
  )
  if (failures.length > 0) {
    throw new Error(`${label} had ${failures.length} unavailable foreground probe(s)`)
  }
}

export function assertConsistentForegroundIdentity(probes) {
  const identities = new Set(
    probes.flatMap((probe) => probe.results.map((result) => result.foreground))
  )
  if (identities.size !== 1) {
    throw new Error(`stable foreground identity changed: ${[...identities].join(', ')}`)
  }
  return identities.values().next().value
}
