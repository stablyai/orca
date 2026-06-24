import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export function pressureOutputScript(runId: string): string {
  return `
const paneIndex = process.argv[2] ?? '0'
const targetChars = Number(process.argv[3] ?? '0')
const delayMs = Number(process.argv[4] ?? '0')
const idleAfterDone = process.argv[5] === 'idle'
const header = 'OPENCODE_PRESSURE_START_${runId}_' + paneIndex + '\\n'
const chunkBody = '#'.repeat(8192)
const chunksPerTurn = 1
let written = 0
process.stdout.write(header)
function writeMore() {
  let canContinue = true
  let chunksThisTurn = 0
  while (canContinue && written < targetChars && chunksThisTurn < chunksPerTurn) {
    const frame = String(written).padStart(8, '0')
    const chunk = '\\x1b[?2026h\\x1b[1;1Hpressure pane=' + paneIndex + ' frame=' + frame + ' ' + chunkBody + '\\x1b[?2026l\\n'
    written += chunk.length
    chunksThisTurn += 1
    canContinue = process.stdout.write(chunk)
  }
  if (written < targetChars) {
    if (canContinue) {
      setTimeout(writeMore, 1)
    } else {
      process.stdout.once('drain', writeMore)
    }
    return
  }
  process.stdout.write('OPENCODE_PRESSURE_DONE_${runId}_' + paneIndex + '\\n')
  if (idleAfterDone) {
    setInterval(() => {}, 1000)
  }
}
setTimeout(writeMore, Number.isFinite(delayMs) && delayMs > 0 ? delayMs : 0)
`
}

export function writePressureOutputScript(scriptPath: string, runId: string): void {
  mkdirSync(path.dirname(scriptPath), { recursive: true })
  writeFileSync(scriptPath, pressureOutputScript(runId))
}
