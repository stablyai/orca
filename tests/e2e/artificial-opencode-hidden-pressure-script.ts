import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export type HiddenPressureOutputMode = 'tui' | 'plain' | 'title' | 'latin' | 'rich-model'

export function pressureOutputScript(runId: string, mode: HiddenPressureOutputMode): string {
  const headerPrefix = mode === 'tui' || mode === 'rich-model' ? '\\x1b[0m' : ''
  const donePrefix = mode === 'tui' || mode === 'rich-model' ? '\\x1b[0m' : ''
  const chunkExpression =
    mode === 'plain'
      ? "'plain pressure pane=' + paneIndex + ' frame=' + frame + ' ' + chunkBody + '\\n'"
      : mode === 'latin'
        ? "'latin pressure café déjà vu São Tomé Żubrówka pane=' + paneIndex + ' frame=' + frame + ' ' + chunkBody + '\\n'"
        : mode === 'title'
          ? "'\\x1b]0;title pressure pane=' + paneIndex + ' frame=' + frame + ' ' + chunkBody + '\\x07'"
          : mode === 'rich-model'
            ? "'\\x1b[?2026h\\x1b[?1049h\\x1b[2J\\x1b[H\\x1b[?25l\\x1b[2;36m╭────────────────────────────────────────╮\\x1b[0m\\r\\n\\x1b[2;36m│ rich model pane=' + paneIndex + ' frame=' + frame + ' 😀 ███░ │\\x1b[0m\\r\\n\\x1b[2;36m│ ' + chunkBody + ' │\\x1b[0m\\r\\n\\x1b[2;36m╰────────────────────────────────────────╯\\x1b[0m\\x1b[6;4H\\x1b[?25h\\x1b[?2026l\\n'"
            : "'\\x1b[?2026h\\x1b[1;1Hpressure pane=' + paneIndex + ' frame=' + frame + ' ' + chunkBody + '\\x1b[?2026l\\n'"
  return `
const paneIndex = process.argv[2] ?? '0'
const targetChars = Number(process.argv[3] ?? '0')
const delayMs = Number(process.argv[4] ?? '0')
const header = '${headerPrefix}OPENCODE_PRESSURE_START_${runId}_' + paneIndex + '\\n'
const chunkBody = '#'.repeat(8192)
let written = 0
process.stdout.write(header)
function writeMore() {
  let canContinue = true
  while (canContinue && written < targetChars) {
    const frame = String(written).padStart(8, '0')
    const chunk = ${chunkExpression}
    written += chunk.length
    canContinue = process.stdout.write(chunk)
  }
  if (written < targetChars) {
    process.stdout.once('drain', writeMore)
    return
  }
  process.stdout.write('${donePrefix}OPENCODE_PRESSURE_DONE_${runId}_' + paneIndex + '\\n')
}
setTimeout(writeMore, Number.isFinite(delayMs) && delayMs > 0 ? delayMs : 0)
`
}

export function writePressureOutputScript(
  scriptPath: string,
  runId: string,
  mode: HiddenPressureOutputMode
): void {
  mkdirSync(path.dirname(scriptPath), { recursive: true })
  writeFileSync(scriptPath, pressureOutputScript(runId, mode))
}
