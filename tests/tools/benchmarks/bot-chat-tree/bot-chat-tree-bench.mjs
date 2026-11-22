// What one botsChanged costs at 20/40 bots x 500/2,000 chats: main-thread ms and chat-tree reads per
// notice. Usage: node tests/tools/benchmarks/bot-chat-tree/bot-chat-tree-bench.mjs [--out <dir>]
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const args = process.argv.slice(2)
const flag = (name) => {
  const at = args.indexOf(name)
  return at === -1 ? undefined : args[at + 1]
}
const out = resolve(flag('--out') ?? join('tmp', 'bot-chat-tree-bench'))
// e.g. --sizes 40x500,40x2000
const sizes = (flag('--sizes') ?? '20x500,20x2000,40x500,40x2000').split(',').map((size) => {
  const [bots, chats] = size.split('x').map(Number)
  return { bots, chats }
})
mkdirSync(out, { recursive: true })

const run = (file, env, label) => {
  const report = join(out, `${label}.json`)
  const result = spawnSync(
    'pnpm',
    [
      'exec',
      'vitest',
      'run',
      '--config',
      'tests/tools/benchmarks/bot-chat-tree/vitest.bot-chat-tree-bench.config.ts',
      file
    ],
    {
      stdio: 'inherit',
      // A 40-bot sidebar of 2,000-chat trees outgrows the default heap under happy-dom.
      env: { ...process.env, ...env, BENCH_OUT: report, NODE_OPTIONS: '--max-old-space-size=12288' }
    }
  )
  if (result.status !== 0) {
    return { label, failed: true }
  }
  return JSON.parse(readFileSync(report, 'utf8'))
}

const reports = []
for (const { bots, chats } of sizes) {
  reports.push(
    run(
      'tests/tools/benchmarks/bot-chat-tree/bot-chat-tree-notices-benchmark.ts',
      { BENCH_BOTS: String(bots), BENCH_CHATS: String(chats) },
      `main-${bots}x${chats}`
    )
  )
}
console.log(JSON.stringify(reports, null, 2))
