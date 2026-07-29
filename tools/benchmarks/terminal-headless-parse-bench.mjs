#!/usr/bin/env node
/**
 * Decomposes cross-terminal pipeline results: feeds the same fixtures from
 * terminal-pipeline-bench through a bare @xterm/headless Terminal — no Orca
 * layers, no IPC, no rendering — to locate where throughput is lost.
 *
 * If headless xterm parses a fixture near the plain-text rate, the pipeline
 * gap for that fixture lives in Orca's layers (delivery, side-effect
 * scanning, renderer paint). If headless collapses too, the cost is intrinsic
 * to xterm.js's parser/buffer for that byte pattern.
 *
 * Usage:
 *   node tools/benchmarks/terminal-headless-parse-bench.mjs
 *     [--size-mb 10] [--cols 114] [--rows 85] [--scrollback 5000]
 */
import { performance } from 'node:perf_hooks'
import xterm from '@xterm/headless'
import { buildFixture } from './terminal-pipeline-bench.mjs'

const { Terminal } = xterm
const CHUNK = 64 * 1024

function arg(name, fallback) {
  const i = process.argv.indexOf(name)
  return i === -1 ? fallback : Number(process.argv[i + 1])
}

const sizeMb = arg('--size-mb', 10)
const cols = arg('--cols', 114)
const rows = arg('--rows', 85)
const scrollback = arg('--scrollback', 5000)
const targetBytes = Math.floor(sizeMb * 1024 * 1024)

function writeAll(term, data) {
  return new Promise((resolve) => {
    let offset = 0
    const next = () => {
      if (offset >= data.length) {
        resolve()
        return
      }
      const chunk = data.slice(offset, offset + CHUNK)
      offset += CHUNK
      // write callback fires after the chunk is parsed — same "fully parsed"
      // fence semantics as the DSR fence in the pipeline bench.
      term.write(chunk, next)
    }
    next()
  })
}

const FIXTURES = ['ascii-log', 'cjk-emoji', 'agent-tui', 'styles-stress']

console.log(
  `headless xterm ${cols}x${rows} scrollback=${scrollback}, ${sizeMb}MB per fixture (parse-only, no render)`
)
for (const name of FIXTURES) {
  const fixture = buildFixture(name, targetBytes, cols, rows)
  const bytes = Buffer.byteLength(fixture, 'utf8')
  const term = new Terminal({ cols, rows, scrollback, allowProposedApi: true })
  // Warmup primes JIT so the first fixture isn't penalized.
  await writeAll(term, fixture.slice(0, 256 * 1024))
  const start = performance.now()
  await writeAll(term, fixture)
  const ms = performance.now() - start
  console.log(
    `${name.padEnd(15)} ${(bytes / 1024 / 1024 / (ms / 1000)).toFixed(1).padStart(7)} MB/s  (${ms.toFixed(0)}ms)`
  )
  term.dispose()
}
