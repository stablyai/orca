const { appendFileSync } = require('node:fs')
const { monitorEventLoopDelay, performance } = require('node:perf_hooks')

const outputPath = process.env.ORCA_PROCESS_ORACLE_EVENT_LOOP_PATH
if (outputPath) {
  const delay = monitorEventLoopDelay({ resolution: 20 })
  let previous = performance.eventLoopUtilization()
  delay.enable()
  const timer = setInterval(() => {
    const utilization = performance.eventLoopUtilization(previous)
    previous = performance.eventLoopUtilization()
    const row = {
      timestamp: new Date().toISOString(),
      pid: process.pid,
      ppid: process.ppid,
      role: process.type ?? (process.env.ELECTRON_RUN_AS_NODE === '1' ? 'daemon' : 'node'),
      argv: process.argv,
      p50Ms: Number(delay.percentile(50) / 1e6),
      p95Ms: Number(delay.percentile(95) / 1e6),
      p99Ms: Number(delay.percentile(99) / 1e6),
      maxMs: Number(delay.max / 1e6),
      utilization: utilization.utilization
    }
    appendFileSync(outputPath, `${JSON.stringify(row)}\n`)
    delay.reset()
  }, 5_000)
  timer.unref()
}
