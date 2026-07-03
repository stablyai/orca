import { readFileSync } from 'node:fs'
import path from 'node:path'

export const EMOJI_TABLE_FIXTURE = readFileSync(
  path.join(__dirname, 'fixtures', 'terminal-emoji-table.md'),
  'utf8'
)
export const NARROW_TERMINAL_MAX_COLS = 120

export function longMarkdownTableScript(runId: string): string {
  const names = [
    ['Sam Syntax', 'Compiler', 'Online', '😀', '9200', 'Semicolons are optional (rage ensues)'],
    ['Tori Token', 'Auth', 'Idle', '🚀', '4800', 'JWT expires during their standup'],
    ['Uma Unpin', 'Frontend', 'Online', '🔥', '3500', 'Absolute positioning enjoyer'],
    ['Vic Variable', 'Types', 'AFK', '💡', '6700', 'any is not a type, it is a cry for help'],
    ['Wally Watchdog', 'Security', 'Online', '📦', '8200', 'Found a vuln in your vuln scanner'],
    ['Xena XPath', 'DB', 'Idle', '🔐', '7300', 'Indexes everything, including the fridge'],
    ['Yuki Yank', 'CLI', 'Online', '🎯', '5900', 'rm -rf / is not a party trick'],
    ['Zane Zealot', 'OSS', 'Offline', '🤖', '10000', 'Contributor to 47 repos, sleeps never'],
    ['Artie ASCII', 'Docs', 'Online', '🧠', '2900', 'Wrote a novel in README comments'],
    ['Bianca Batch', 'ML', 'AFK', '💾', '9400', 'Training a model to write PR descriptions'],
    ['Carlos Cache', 'CDN', 'Idle', '⚙', '4900', 'Stale data is still data'],
    ['Diana Draft', 'Planning', 'Online', '📚', '1800', 'Needs 3 more sprints to estimate'],
    ['Edgar Exit', 'Ops', 'Online', '🔧', '7600', 'Graceful shutdown specialist'],
    ['Fiona Fallback', 'Resilience', 'Idle', '🧲', '5500', 'Circuit breaker connoisseur'],
    ['Gabe Garbage', 'GC', 'Offline', '🧹', '4100', 'Stop-the-world is my catchphrase'],
    ['Holly Hotfix', 'Release', 'Online', '🧪', '6300', 'Friday deploy champion'],
    ['Ira Idempotent', 'API', 'AFK', '🔁', '6900', 'PUT me in coach'],
    ['Jules Jitter', 'Mobile', 'Idle', '📱', '3200', 'Offline-first, coffee-second'],
    ['Ken Kafka', 'Streams', 'Online', '📡', '7100', 'Rebalancing is a lifestyle'],
    ['Luna Latency', 'Edge', 'Offline', '🧭', '4400', 'Response time measured in business days'],
    ['Max Marshal', 'Memory', 'Online', '🧩', '8700', "Leak-free since '24"],
    ['Nora Null', 'Safety', 'AFK', '❓', '3800', 'null is a person, not a value'],
    ['Otto Offset', 'Cursors', 'Idle', '👆', '2600', 'Infinite scroll for the infinite soul'],
    ['Pam Payload', 'Serialization', 'Online', '📦', '5800', 'JSON.stringify is my yoga'],
    ['Reed Regex', 'Matching', 'Offline', '🔍', '6800', 'Now I have two problems']
  ]
  return `
const rows = ${JSON.stringify(names)}
const widths = [16, 14, 12, 6, 7, 42]
function isCombiningMark(codePoint) {
  return (codePoint >= 0x0300 && codePoint <= 0x036f) ||
    (codePoint >= 0xfe00 && codePoint <= 0xfe0f)
}
function isWideCodePoint(codePoint) {
  return codePoint > 0xffff ||
    (codePoint >= 0x1100 && codePoint <= 0x115f) ||
    (codePoint >= 0x2e80 && codePoint <= 0xa4cf) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xfe10 && codePoint <= 0xfe6f) ||
    (codePoint >= 0xff00 && codePoint <= 0xff60) ||
    (codePoint >= 0xffe0 && codePoint <= 0xffe6)
}
function cellWidth(text) {
  let width = 0
  for (const char of String(text)) {
    const codePoint = char.codePointAt(0)
    if (codePoint === undefined || isCombiningMark(codePoint)) continue
    width += isWideCodePoint(codePoint) ? 2 : 1
  }
  return width
}
function cell(value, width) {
  const text = String(value)
  return text + ' '.repeat(Math.max(1, width - cellWidth(text)))
}
function line(parts) {
  return '| ' + parts.map((part, index) => cell(part, widths[index])).join(' | ') + ' |'
}
const outputRows = []
outputRows.push(line(['Name', 'Team', 'Status', 'Icon', 'Score', 'Notes']))
outputRows.push('|-' + widths.map((width) => '-'.repeat(width)).join('-|-') + '-|')
for (let repeat = 0; repeat < 4; repeat += 1) {
  for (const row of rows) outputRows.push(line(row))
}
async function writeStdout(chunk) {
  await new Promise((resolve) => process.stdout.write(chunk, resolve))
  if (process.platform === 'win32') await new Promise((resolve) => setTimeout(resolve, 8))
}
await writeStdout('\\x1b[?2026h\\x1b[2J\\x1b[H')
for (const row of outputRows) {
  await writeStdout(row + '\\n')
}
await writeStdout('\\x1b[?2026l')
await writeStdout('LONG_TABLE_SCROLL_RESTORE_${runId}\\n')
`
}

export function emojiFixtureMarkdownTableScript(table: string, runId: string): string {
  const marker = `EMOJI_FIXTURE_TABLE_RESTORE_${runId}`
  const widthMarker = `EMOJI_FIXTURE_TABLE_WIDTH_${runId}`
  return `
const table = ${JSON.stringify(table)}
const minimumWidths = [2, 5, 4, 7, 7, 4, 3, 4]
const preferredWidths = [5, 17, 10, 18, 30, 12, 10, 10]
const tableOverhead = preferredWidths.length * 3 + 1
const widthBudget = Math.max(
  minimumWidths.reduce((sum, width) => sum + width, 0),
  Math.min(
    preferredWidths.reduce((sum, width) => sum + width, 0),
    (process.stdout.columns || 100) - tableOverhead - 1
  )
)
let remaining = widthBudget
let remainingPreferred = preferredWidths.reduce((sum, width) => sum + width, 0)
const widths = preferredWidths.map((preferred, index) => {
  const minimum = minimumWidths[index]
  const width = Math.max(minimum, Math.floor((remaining * preferred) / remainingPreferred))
  remaining -= width
  remainingPreferred -= preferred
  return width
})
const generatedTableWidth = widths.reduce((sum, width) => sum + width, 0) + tableOverhead
const border = {
  top: ['┌', '┬', '┐'],
  middle: ['├', '┼', '┤'],
  bottom: ['└', '┴', '┘'],
  vertical: '│',
  horizontal: '─'
}
function splitMarkdownRow(row) {
  return row.trim().slice(1, -1).split('|').map((cell) => cell.trim())
}
function isSeparatorRow(row) {
  return /^\\|(?:\\s*:?-+:?\\s*\\|)+\\s*$/.test(row)
}
function cellWidth(text) {
  let width = 0
  for (const char of String(text)) {
    const codePoint = char.codePointAt(0)
    if (codePoint === undefined || (codePoint >= 0x0300 && codePoint <= 0x036f)) continue
    if (codePoint === 0xfe0f || codePoint === 0x200d) continue
    width += codePoint > 0xffff || (codePoint >= 0x1100 && codePoint <= 0x115f) ? 2 : 1
  }
  return width
}
function padCell(value, width) {
  const text = String(value)
  return text + ' '.repeat(Math.max(0, width - cellWidth(text)))
}
function splitToWidth(text, width) {
  const parts = []
  let line = ''
  for (const char of String(text)) {
    const next = line + char
    if (line && cellWidth(next) > width) {
      parts.push(line)
      line = char
    } else {
      line = next
    }
  }
  if (line) parts.push(line)
  return parts
}
function wrapCell(value, width) {
  const words = String(value).split(/\\s+/)
  const lines = []
  let line = ''
  for (const word of words) {
    if (cellWidth(word) > width) {
      if (line) {
        lines.push(line)
        line = ''
      }
      lines.push(...splitToWidth(word, width))
      continue
    }
    const next = line ? line + ' ' + word : word
    if (line && cellWidth(next) > width) {
      lines.push(line)
      line = word
    } else {
      line = next
    }
  }
  if (line) lines.push(line)
  return lines.length ? lines : ['']
}
function rule(parts) {
  return parts[0] + widths.map((width) => border.horizontal.repeat(width + 2)).join(parts[1]) + parts[2]
}
function renderRow(cells) {
  const wrappedCells = widths.map((width, index) => wrapCell(cells[index] ?? '', width))
  const height = Math.max(...wrappedCells.map((cell) => cell.length))
  const rows = []
  for (let line = 0; line < height; line += 1) {
    rows.push(
      border.vertical +
        widths
          .map((width, index) => ' ' + padCell(wrappedCells[index][line] ?? '', width) + ' ')
          .join(border.vertical) +
        border.vertical
    )
  }
  return rows
}
async function writeStdout(chunk) {
  await new Promise((resolve) => process.stdout.write(chunk, resolve))
  if (process.platform === 'win32') await new Promise((resolve) => setTimeout(resolve, 8))
}
const parsedRows = table
  .split(/\\r?\\n/)
  .filter((row) => row.trim().startsWith('|') && !isSeparatorRow(row))
  .map(splitMarkdownRow)
const rendered = [rule(border.top)]
for (const [index, row] of parsedRows.entries()) {
  rendered.push(...renderRow(row))
  rendered.push(rule(index === parsedRows.length - 1 ? border.bottom : border.middle))
}
await writeStdout('\\x1b[?2026h\\x1b[2J\\x1b[H')
for (const line of rendered) {
  await writeStdout(line + '\\r\\n')
}
await writeStdout('\\x1b[?2026l')
await writeStdout('${widthMarker}:' + generatedTableWidth + '\\r\\n')
await writeStdout('${marker}\\r\\n')
`
}

export function emojiFixtureTableWidthMarker(runId: string): string {
  return `EMOJI_FIXTURE_TABLE_WIDTH_${runId}:`
}

export function narrowSignerMarkdownTableScript(runId: string): string {
  const marker = `NARROW_SIGNER_TABLE_RESTORE_${runId}`
  const rows = [
    '| # | Status | Signer | Action |',
    '| ---: | --- | --- | --- |',
    '| 1 | signed | did:key:z6Mkuw5kQqz1QvZ9f3d2aB7f19f0cAC7B4F3c9E725aD19cD12e6A8B3F4c5D6e7F8a9B0c1D2e3F4a5B6c7D8e9F0a1B2c3D4e5F6a7B8c9D0e1F2 | approve deployment |',
    '| 2 | waiting | did:web:example.signing.service:teams:release:prod:primary-key-2026-06-08-with-extra-qualifiers-and-long-human-readable-suffix | counter-sign |',
    '| 3 | signed | 0x742d35Cc6634C0532925a3b844Bc454e4438f44e9E8F12A7C4D9B6530F9D2C8E7A6B5C4D3E2F1A0B998877665544332211 | archive receipt |'
  ]
  const repeatedRows = Array.from({ length: 8 }, (_, index) =>
    rows.concat(`| ${index + 4} | signed | signer-row-${index}-${'a'.repeat(96)} | verify |`)
  ).flat()
  return `
const rows = ${JSON.stringify(repeatedRows)}
async function writeStdout(chunk) {
  await new Promise((resolve) => process.stdout.write(chunk, resolve))
  if (process.platform === 'win32') await new Promise((resolve) => setTimeout(resolve, 8))
}
await writeStdout('\\x1b[?2026h\\x1b[2J\\x1b[H')
for (const row of rows) {
  await writeStdout(row + '\\r\\n')
}
await writeStdout('\\x1b[?2026l')
await writeStdout('${marker}\\r\\n')
`
}
