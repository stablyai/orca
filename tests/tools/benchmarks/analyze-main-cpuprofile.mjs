#!/usr/bin/env node
// Bucket main .cpuprofile self-time through source maps to separate spawn/stdout cost (movable to utility process) from parsing/IPC.
// Use nearest mappings because esbuild’s source-less segments made exact lookup classify ~1/3 of busy samples as unknown.
// Usage: node tests/tools/benchmarks/analyze-main-cpuprofile.mjs <file.cpuprofile> [--top 30]
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { TraceMap, decodedMappings } from '@jridgewell/trace-mapping'

const args = process.argv.slice(2)
const profilePath = args.find((arg) => !arg.startsWith('--'))
if (!profilePath) {
  throw new Error('Usage: analyze-main-cpuprofile.mjs <file.cpuprofile> [--top N]')
}
const topIndex = args.indexOf('--top')
const top = topIndex === -1 ? 30 : Number(args[topIndex + 1])

const profile = JSON.parse(readFileSync(profilePath, 'utf8'))
const indexCache = new Map()

/** Per generated line: columns that carry a source, ascending, for a lower-bound scan. */
function mappingIndexFor(url) {
  if (indexCache.has(url)) {
    return indexCache.get(url)
  }
  let built = null
  if (url.startsWith('file://')) {
    const filePath = new URL(url).pathname
    try {
      const map = new TraceMap(JSON.parse(readFileSync(`${filePath}.map`, 'utf8')))
      const lines = decodedMappings(map)
      built = {
        dir: dirname(filePath),
        sources: map.sources,
        names: map.names,
        lines: lines.map((segments) => segments.filter((segment) => segment.length >= 4))
      }
    } catch {
      built = null
    }
  }
  indexCache.set(url, built)
  return built
}

function sourceRelative(dir, source) {
  const absolute = resolve(dir, source)
  const marker = absolute.indexOf('/src/')
  return marker === -1 ? absolute : absolute.slice(marker + 1)
}

/** Source-relative origin of a frame, e.g. "src/main/git/status/porcelain.ts:parseEntry". */
function originOf(frame) {
  if (!frame.url) {
    return frame.functionName ? `<internal:${frame.functionName}>` : '<unknown>'
  }
  const index = mappingIndexFor(frame.url)
  if (!index) {
    return frame.url
  }
  const segments = index.lines[frame.lineNumber] ?? []
  let chosen = null
  for (const segment of segments) {
    if (segment[0] > frame.columnNumber) {
      break
    }
    chosen = segment
  }
  if (!chosen) {
    return `${frame.url}#unmapped:${frame.lineNumber}:${frame.columnNumber}`
  }
  const file = sourceRelative(index.dir, index.sources[chosen[1]] ?? '?')
  const name =
    (chosen.length >= 5 ? index.names[chosen[4]] : null) ?? frame.functionName ?? '(anon)'
  return `${file}:${name}`
}

// Classify by V8 function name first: greatest-lower-bound mapping can name the preceding file; unminified names are more trustworthy.
// Native spawn without URL is process_wrap’s synchronous posix_spawn holding main.
const NAME_RULES = [
  [/^\((?:idle|program)\)$/, 'idle/program'],
  [/^\(garbage collector\)$/, 'gc'],
  // Environment construction belongs to spawn preparation and moves with spawn.
  [
    /^(?:spawn|spawnSync|normalizeSpawnArguments|validateArgumentNullCheck|validateTimeout|ChildProcess|setupChannel|execFile|execFileSync|spawnWithSignal)$/,
    'spawn-init'
  ],
  [
    /Env$|^untranslatedGitOutputEnv$|^resolveSpawn$|^spawnProcess$|^runProcess$|^getSpawnArgsForWindows$/,
    'spawn-init'
  ],
  [
    /^(?:onStreamRead|Socket|readableAddChunk|emitReadable|onread|write|flow|resume_|StringDecoder|utf8Write|text|createOutputSink)$/,
    'stdout-drain'
  ],
  [/^(?:parse|attachLineStats|createInputIdentity|runGetStatus|detect|read)/, 'git-parse'],
  [/Porcelain|Numstat|ChangedEntry|StatusEntry/i, 'git-parse'],
  [
    /^(?:hydrateRepo|getWorktreeRootOwnerKey|getLocalWorktreeRootOwners|collectRepoIdsWithRegisteredWorktreeMeta|resolveRegisteredWorktreePath|getRepos|normalizeString|join|resolve|relative|isAbsolute)/,
    'store+path-orchestration'
  ],
  [/^(?:sendReply|_invokeHandler|ipc)/i, 'ipc']
]

const URL_RULES = [
  [/child_process|spawn-resolution|run-process\.(?:ts|js)/, 'spawn-init'],
  [
    /string_decoder|node:internal\/streams|node:stream|node:net|bounded-output-sink/,
    'stdout-drain'
  ],
  [/src\/main\/git\/|src\/shared\/git|porcelain/, 'git-parse'],
  [/electron\/js2c|src\/main\/ipc\//, 'ipc'],
  [/node:internal\/fs|node:fs/, 'fs'],
  [/src\//, 'other-orca'],
  [/node:/, 'other-node']
]

function bucketOf(label) {
  const name = label.includes(' @') ? label.slice(0, label.indexOf(' @')) : label
  for (const [pattern, bucket] of NAME_RULES) {
    if (pattern.test(name)) {
      return bucket
    }
  }
  for (const [pattern, bucket] of URL_RULES) {
    if (pattern.test(label)) {
      return bucket
    }
  }
  return 'other'
}

// Display generated positions for bundle frames: lower-bound mappings can name the wrong file, while unminified functions identify code.
function displayLocation(frame) {
  if (!frame.url) {
    return '<native>'
  }
  if (!frame.url.startsWith('file://')) {
    return frame.url
  }
  const mapped = originOf(frame)
  const leaf = frame.url.split('/').at(-1)
  return `${leaf}:${frame.lineNumber}  ~${typeof mapped === 'string' ? mapped.split('#')[0].split('/').at(-1) : mapped}`
}

const wallUs = profile.endTime - profile.startTime
const sampleUs = wallUs / profile.samples.length
const selfBySite = new Map()
for (const node of profile.nodes) {
  if (!node.hitCount) {
    continue
  }
  const label = `${node.callFrame.functionName || '(anon)'} @${displayLocation(node.callFrame)}`
  selfBySite.set(label, (selfBySite.get(label) ?? 0) + node.hitCount)
}
const totalHits = [...selfBySite.values()].reduce((sum, hits) => sum + hits, 0)

const byBucket = new Map()
for (const [label, hits] of selfBySite) {
  const bucket = bucketOf(label)
  byBucket.set(bucket, (byBucket.get(bucket) ?? 0) + hits)
}

const ms = (hits) => Math.round((hits * sampleUs) / 100) / 10
const busyHits = totalHits - (byBucket.get('idle/program') ?? 0)

console.log(`profile: ${profilePath}`)
console.log(
  `wall ${(wallUs / 1000).toFixed(0)}ms  samples ${profile.samples.length}  sampleInterval ${sampleUs.toFixed(0)}us`
)
console.log(
  `busy (non-idle) main-thread time: ${ms(busyHits)}ms = ${((busyHits / totalHits) * 100).toFixed(1)}% of wall`
)
console.log('\nbuckets (self time):')
for (const [bucket, hits] of [...byBucket].sort((a, b) => b[1] - a[1])) {
  const shareOfBusy =
    bucket === 'idle/program' ? '' : `  ${((hits / busyHits) * 100).toFixed(1)}% of busy`
  console.log(
    `  ${bucket.padEnd(24)} ${String(ms(hits)).padStart(8)}ms  ${((hits / totalHits) * 100).toFixed(2)}% of wall${shareOfBusy}`
  )
}
console.log(`\ntop ${top} self-time sites:`)
for (const [label, hits] of [...selfBySite].sort((a, b) => b[1] - a[1]).slice(0, top)) {
  console.log(
    `  ${String(ms(hits)).padStart(8)}ms  ${((hits / busyHits) * 100).toFixed(1)}%busy  [${bucketOf(label)}] ${label}`
  )
}
