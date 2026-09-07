// Parent runner for the #7547 watcher.node crash harness. Spawns child.cjs in
// a loop and reports native crash exit codes (0xC0000409 fail-fast, 0xC0000005
// AV, etc.). Usage:
//   node run.cjs <scenario|mixed|all> [iterations] [durationMs]
'use strict'

const { spawn } = require('node:child_process')
const path = require('node:path')

const CHILD = path.join(__dirname, 'child.cjs')
const KNOWN = {
  3221226505: 'STATUS_STACK_BUFFER_OVERRUN (0xC0000409) — fail-fast/abort  << TARGET',
  3221225477: 'STATUS_ACCESS_VIOLATION (0xC0000005)',
  3221225725: 'STATUS_STACK_OVERFLOW (0xC00000FD)',
  3221226356: 'STATUS_HEAP_CORRUPTION (0xC0000374)',
  134: 'SIGABRT (128+6)'
}

function hex(code) {
  return code >= 0 ? `0x${code.toString(16).toUpperCase()}` : String(code)
}

function runOnce(scenario, durationMs) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CHILD, scenario, String(durationMs)], {
      stdio: ['ignore', 'inherit', 'pipe']
    })
    let stderr = ''
    child.stderr.on('data', (d) => {
      stderr += d
      process.stderr.write(d)
    })
    child.on('exit', (code, signal) => resolve({ code, signal, stderr }))
  })
}

async function main() {
  const scenario = process.argv[2] || 'mixed'
  const iterations = Number(process.argv[3] || 10)
  const durationMs = Number(process.argv[4] || 15000)
  const scenarios =
    scenario === 'all'
      ? ['delete-root', 'unsub-churn', 'worker-mix', 'overflow', 'mixed']
      : [scenario]

  const results = []
  let crashed = false
  outer: for (const s of scenarios) {
    for (let i = 1; i <= iterations; i++) {
      const started = Date.now()
      console.log(`\n=== [${s}] iteration ${i}/${iterations} (${durationMs}ms) ===`)
      const { code, signal } = await runOnce(s, durationMs)
      const elapsed = Date.now() - started
      const meaning = KNOWN[code] || (code === 0 ? 'clean exit' : 'unexpected')
      console.log(
        `=== [${s}] iter ${i}: exit=${code} (${hex(code ?? -1)}) signal=${signal} ${meaning} after ${elapsed}ms`
      )
      results.push({ scenario: s, iteration: i, code, signal, elapsed })
      if (code !== 0 && code !== null) {
        crashed = true
        console.log(`\n*** NATIVE CRASH REPRODUCED in scenario "${s}" (exit ${hex(code)}) ***`)
        break outer
      }
    }
  }

  console.log('\n──── summary ────')
  for (const r of results) {
    console.log(
      `${r.scenario.padEnd(12)} #${r.iteration} exit=${hex(r.code ?? -1)} ${r.signal || ''} ${r.elapsed}ms`
    )
  }
  process.exit(crashed ? 1 : 0)
}

main()
