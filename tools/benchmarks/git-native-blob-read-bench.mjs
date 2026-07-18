#!/usr/bin/env node
/**
 * Compares p50/p95 latency of `git show HEAD:<file>` (spawn a git process per
 * read) vs the git-native addon's in-process readBlobAtRevPath.
 *
 * Usage:
 *   node tools/benchmarks/git-native-blob-read-bench.mjs [repoPath] [filePath]
 *
 * Prereq: the native addon must be built —
 *   pnpm build:git-native
 */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const require = createRequire(import.meta.url)

const repo = path.resolve(process.argv[2] ?? '.')
const file = process.argv[3] ?? 'package.json'
const ITERATIONS = 200
const MAX_BYTES = 10 * 1024 * 1024

const addonPath = path.resolve('native/git-native/.build/git-native.node')
// A native .node file cannot go through ESM import() — createRequire is the
// only load path that works from an .mjs entrypoint.
if (!existsSync(addonPath)) {
  console.error(`git-native addon not found at ${addonPath}`)
  console.error('Build it with `pnpm build:git-native`')
  process.exit(1)
}
const native = require(addonPath)

console.log(`repo=${repo} file=${file} iterations=${ITERATIONS}`)

async function bench(label, fn) {
  const samples = []
  await fn() // warmup
  for (let i = 0; i < ITERATIONS; i++) {
    const start = process.hrtime.bigint()
    await fn()
    samples.push(Number(process.hrtime.bigint() - start) / 1e6)
  }
  samples.sort((a, b) => a - b)
  const p = (q) => samples[Math.floor(samples.length * q)]
  const p50 = p(0.5)
  const p95 = p(0.95)
  console.log(`${label}: p50=${p50.toFixed(2)}ms p95=${p95.toFixed(2)}ms`)
  return { p50, p95 }
}

const cli = await bench('cli  git show', () =>
  execFileAsync('git', ['show', '--end-of-options', `HEAD:${file}`], {
    cwd: repo,
    maxBuffer: MAX_BYTES,
    encoding: 'buffer'
  }))
const nativeResult = await bench('native gix   ', () =>
  native.readBlobAtRevPath(repo, 'HEAD', file, MAX_BYTES))

console.log(`speedup (cli p50 / native p50): ${(cli.p50 / nativeResult.p50).toFixed(1)}x`)
