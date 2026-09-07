// Replays the desktop's region selection (relay-region-preference.ts) with the same probe,
// sample count, spread rule, and Node fetch, and prints why each region passed or failed.
import {
  LIVE_ENV_VAR,
  parseArgs,
  requireDirector,
  requireLiveRun
} from './relay-bench-invocation.mjs'

const USAGE = `${LIVE_ENV_VAR}=1 node region-probe-replay.mjs --director=<origin> [--rounds=N]`
const SAMPLES = 3
const PROBE_TIMEOUT_MS = 1500

const probe = async (origin) => {
  const started = performance.now()
  try {
    const res = await fetch(`${origin}/health`, {
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS)
    })
    await res.arrayBuffer()
    return res.ok ? performance.now() - started : null
  } catch {
    return null
  }
}

async function sampleRegion(entry) {
  const samples = []
  for (let index = 0; index < SAMPLES; index++) {
    const latencies = (await Promise.all(entry.probeOrigins.map(probe))).filter(
      (value) => value !== null
    )
    samples.push(Math.min(...latencies))
  }
  const raw = samples.map((value) => Math.round(value))
  samples.sort((a, b) => a - b)
  const median = samples[1]
  const spread = samples[2] - samples[0]
  return {
    region: entry.region,
    samples: raw,
    median: Math.round(median),
    spread: Math.round(spread),
    // The shipped rule: a wide spread means the samples are untrustworthy, not that the
    // region is far, so the region is dropped rather than ranked.
    verdict: spread > Math.max(20, median * 0.5) ? 'REJECTED (spread)' : 'ok'
  }
}

const { options } = parseArgs(process.argv.slice(2))
requireLiveRun(USAGE)
const director = requireDirector(options, USAGE)
const rounds = Number(options.get('--rounds') ?? 3)

const catalog = await (await fetch(`${director}/v1/regions`)).json()
for (let round = 0; round < rounds; round++) {
  console.log(JSON.stringify(await Promise.all(catalog.regions.map(sampleRegion))))
}
