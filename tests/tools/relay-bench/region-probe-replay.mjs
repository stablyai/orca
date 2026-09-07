// Replays the desktop's region selection (relay-region-preference.ts) with the same
// probe, sample count, spread rule, and Node fetch, and prints why each region passed or failed.
const director = 'https://relay.onorca.dev'
const SAMPLES = 3,
  TIMEOUT = 1500
const probe = async (origin) => {
  const t0 = performance.now()
  try {
    const r = await fetch(`${origin}/health`, {
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT)
    })
    await r.arrayBuffer()
    return r.ok ? performance.now() - t0 : null
  } catch {
    return null
  }
}
const catalog = await (await fetch(`${director}/v1/regions`)).json()
for (let round = 0; round < Number(process.argv[2] ?? 3); round++) {
  const out = []
  await Promise.all(
    catalog.regions.map(async (entry) => {
      const samples = []
      for (let i = 0; i < SAMPLES; i++) {
        const l = (await Promise.all(entry.probeOrigins.map(probe))).filter((x) => x !== null)
        samples.push(Math.min(...l))
      }
      const raw = samples.map((s) => Math.round(s))
      samples.sort((a, b) => a - b)
      const median = samples[1],
        spread = samples[2] - samples[0]
      const rejected = spread > Math.max(20, median * 0.5)
      out.push({
        region: entry.region,
        samples: raw,
        median: Math.round(median),
        spread: Math.round(spread),
        verdict: rejected ? 'REJECTED (spread)' : 'ok'
      })
    })
  )
  console.log(JSON.stringify(out))
}
