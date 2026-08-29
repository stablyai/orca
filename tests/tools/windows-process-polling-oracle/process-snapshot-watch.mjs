import { appendFileSync, existsSync, writeFileSync } from 'node:fs'
import processTree from '@vscode/windows-process-tree'

function readArg(name, fallback) {
  const index = process.argv.indexOf(name)
  return index !== -1 ? process.argv[index + 1] : fallback
}

const outputPath = readArg('--output')
const readyPath = readArg('--ready')
const stopPath = readArg('--stop')
const durationLimitMs = Number(readArg('--duration-ms', '5000'))
const intervalMs = Number(readArg('--interval-ms', '25'))
if (!outputPath || !readyPath) {
  throw new Error('--output and --ready are required')
}
writeFileSync(outputPath, '', { flag: 'wx' })

function snapshot() {
  return new Promise((resolve, reject) => {
    try {
      processTree.getAllProcesses((rows) => {
        if (!Array.isArray(rows)) {
          reject(new Error('native process snapshot returned no rows'))
        } else {
          resolve(rows)
        }
      }, processTree.ProcessDataFlag.Memory | processTree.ProcessDataFlag.CommandLine)
    } catch (error) {
      reject(error)
    }
  })
}

let active = new Set((await snapshot()).map((row) => row.pid))
const startedAt = Date.now()
writeFileSync(readyPath, `${process.pid}\n`, { flag: 'wx' })
const deadline = startedAt + durationLimitMs
let polls = 0
const snapshotDurationsMs = []
while (Date.now() < deadline && (!stopPath || !existsSync(stopPath))) {
  const startedAt = Date.now()
  const rows = await snapshot()
  snapshotDurationsMs.push(Date.now() - startedAt)
  polls += 1
  const next = new Set(rows.map((row) => row.pid))
  for (const row of rows) {
    if (active.has(row.pid)) {
      continue
    }
    appendFileSync(
      outputPath,
      `${JSON.stringify({
        timestamp: new Date().toISOString(),
        name: row.name,
        pid: row.pid,
        parentPid: row.ppid,
        commandLine: row.commandLine ?? '',
        memoryBytes: row.memory,
        argvCaptureStatus: row.commandLine === undefined ? 'unavailable' : 'captured'
      })}\n`
    )
  }
  active = next
  await new Promise((resolve) =>
    setTimeout(resolve, Math.max(0, intervalMs - (Date.now() - startedAt)))
  )
}
snapshotDurationsMs.sort((a, b) => a - b)
const stoppedByMarker = Boolean(stopPath && existsSync(stopPath))
const percentile = (fraction) =>
  snapshotDurationsMs[
    Math.min(snapshotDurationsMs.length - 1, Math.floor(snapshotDurationsMs.length * fraction))
  ]
appendFileSync(
  outputPath,
  `${JSON.stringify({
    type: 'summary',
    polls,
    durationMs: Date.now() - startedAt,
    durationLimitMs,
    stoppedByMarker,
    intervalMs,
    snapshotP50Ms: percentile(0.5),
    snapshotP95Ms: percentile(0.95),
    snapshotMaxMs: snapshotDurationsMs.at(-1)
  })}\n`
)
