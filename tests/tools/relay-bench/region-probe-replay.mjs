// Replays the desktop's region selection (relay-region-preference.ts) with the same probe,
// sample count, spread rule, and Node fetch, and prints why each region passed or failed.
import { pathToFileURL } from 'node:url'
import {
  classifyPublicHttpsOrigin,
  LIVE_ENV_VAR,
  parseArgs,
  requireBoundedInteger,
  requireDirector,
  requireLiveRun,
  resolvesToPublicAddress
} from './relay-bench-invocation.mjs'

const USAGE = `${LIVE_ENV_VAR}=1 node region-probe-replay.mjs --director=<origin> [--rounds=N]`
const SAMPLES = 3
const PROBE_TIMEOUT_MS = 1500
const CATALOG_TIMEOUT_MS = 10_000
const MAX_ROUNDS = 1000

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

// The catalog names the destinations, so a compromised or spoofed director would otherwise get to
// aim this harness at the operator's loopback and private networks. redirect: 'error' above only
// constrains where a probe may go next, never where the first request goes.
export async function vetProbeOrigins(entry, deps) {
  const allowed = []
  const refused = []
  for (const origin of entry.probeOrigins ?? []) {
    const verdict = classifyPublicHttpsOrigin(origin)
    if (!verdict.ok) {
      refused.push(verdict.reason)
      continue
    }
    const resolved = await resolvesToPublicAddress(verdict.origin, deps)
    if (!resolved.ok) {
      refused.push(resolved.reason)
      continue
    }
    allowed.push(verdict.origin)
  }
  return { allowed, refused }
}

export async function sampleRegion(entry, deps) {
  const { allowed, refused } = await vetProbeOrigins(entry, deps)
  const base = { region: entry.region, samples: [], median: null, spread: null }
  if (!allowed.length) {
    return { ...base, refusedOrigins: refused, verdict: 'REFUSED (no allowed probe origin)' }
  }
  const samples = []
  for (let index = 0; index < SAMPLES; index++) {
    const latencies = (await Promise.all(allowed.map(deps?.probe ?? probe))).filter(
      (value) => value !== null
    )
    // Math.min of nothing is Infinity, which would spread into NaN and read as a passing region.
    if (!latencies.length) {
      return {
        ...base,
        samples: samples.map(Math.round),
        verdict: 'UNREACHABLE (every probe failed)'
      }
    }
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
    ...(refused.length ? { refusedOrigins: refused } : {}),
    // The shipped rule: a wide spread means the samples are untrustworthy, not that the
    // region is far, so the region is dropped rather than ranked.
    verdict: spread > Math.max(20, median * 0.5) ? 'REJECTED (spread)' : 'ok'
  }
}

async function main() {
  const { options } = parseArgs(process.argv.slice(2))
  requireLiveRun(USAGE)
  const director = requireDirector(options, USAGE)
  const rounds = requireBoundedInteger(options.get('--rounds'), '--rounds', USAGE, {
    min: 1,
    max: MAX_ROUNDS,
    fallback: 3
  })

  let catalog
  try {
    const res = await fetch(`${director}/v1/regions`, {
      signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS)
    })
    catalog = await res.json()
  } catch (err) {
    const timedOut = err.name === 'TimeoutError' || err.cause?.name === 'TimeoutError'
    console.error(
      timedOut
        ? `director ${director}/v1/regions did not answer within ${CATALOG_TIMEOUT_MS} ms`
        : `director ${director}/v1/regions failed: ${err.message}`
    )
    process.exitCode = 1
    return
  }
  if (!Array.isArray(catalog?.regions) || catalog.regions.length === 0) {
    console.error(`director ${director}/v1/regions returned no regions`)
    process.exitCode = 1
    return
  }
  for (let round = 0; round < rounds; round++) {
    console.log(
      JSON.stringify(await Promise.all(catalog.regions.map((entry) => sampleRegion(entry))))
    )
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
