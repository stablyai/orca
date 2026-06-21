import { randomUUID } from 'node:crypto'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Page, TestInfo } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import {
  ensureTerminalVisible,
  getAllWorktreeIds,
  switchToWorktree,
  waitForActiveWorktree,
  waitForSessionReady
} from './helpers/store'
import {
  getTerminalContent,
  sendToTerminal,
  waitForActivePanePtyId,
  waitForActiveTerminalManager
} from './helpers/terminal'
import { scrollActiveTerminalToText } from './artificial-opencode-active-terminal-scroll'
import {
  waitForPtyColumnsAtMost,
  waitForRenderedTerminalColumnsAtMost
} from './terminal-column-probes'
import { nodeTerminalCommand } from './terminal-node-command'
import { waitForPtyShellEcho } from './terminal-pty-readiness'

type TerminalRenderDiagnostics = {
  cols: number
  rows: number
  viewportY: number
  baseY: number
  hasComplexScriptOutput: boolean
  hasWebgl: boolean
  canvasCount: number
  cursorHidden: boolean | null
  visibleLineTails: string[]
  allPaneStates: {
    tabId: string
    paneId: number
    hasComplexScriptOutput: boolean
    hasMarker: boolean
    hasWebgl: boolean
  }[]
}

type LongTableDebugWindow = Window & {
  __terminalPtyOutputDebug?: {
    reset: () => void
    snapshot: () => {
      hiddenRendererSkipCount: number
      hiddenRendererSkippedChars: number
      hiddenRendererMode2031ReplyCount: number
    }
  }
}

const EMOJI_TABLE_FIXTURE = readFileSync(
  path.join(__dirname, 'fixtures', 'terminal-emoji-table.md'),
  'utf8'
)
const NARROW_TERMINAL_MAX_COLS = 120

function longMarkdownTableScript(runId: string): string {
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

function emojiFixtureMarkdownTableScript(table: string, runId: string): string {
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

function emojiFixtureTableWidthMarker(runId: string): string {
  return `EMOJI_FIXTURE_TABLE_WIDTH_${runId}:`
}

function narrowSignerMarkdownTableScript(runId: string): string {
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

async function setNarrowTerminalViewport(page: Page): Promise<void> {
  await page.setViewportSize({ width: 900, height: 820 })
  await page.waitForTimeout(250)
  await page.evaluate(() => {
    const store = window.__store
    if (store?.getState().rightSidebarOpen) {
      store.getState().setRightSidebarOpen(false)
    }
  })
  await page.waitForTimeout(250)
}

async function setRenderedTableViewport(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1180, height: 820 })
  await page.waitForTimeout(250)
  await page.evaluate(() => {
    const store = window.__store
    if (store?.getState().rightSidebarOpen) {
      store.getState().setRightSidebarOpen(false)
    }
  })
  await page.waitForTimeout(250)
}

async function scrollActiveTerminalLikeUser(page: Page): Promise<void> {
  const target = await page.evaluate(() => {
    const store = window.__store
    const state = store?.getState()
    const worktreeId = state?.activeWorktreeId
    const tabId =
      state?.activeTabType === 'terminal'
        ? state.activeTabId
        : worktreeId
          ? (state?.activeTabIdByWorktree?.[worktreeId] ?? null)
          : null
    const manager = tabId ? window.__paneManagers?.get(tabId) : null
    const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0] ?? null
    if (!pane) {
      throw new Error('Active terminal pane unavailable')
    }
    pane.terminal.focus()
    pane.terminal.scrollToBottom()
    const viewport =
      pane.container.querySelector<HTMLElement>('.xterm-viewport') ??
      pane.container.querySelector<HTMLElement>('.xterm')
    if (!viewport) {
      throw new Error('Active terminal viewport unavailable')
    }
    const rect = viewport.getBoundingClientRect()
    return {
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2
    }
  })
  await page.mouse.move(target.x, target.y)
  await page.mouse.wheel(0, -1800)
  await page.waitForTimeout(250)
}

async function readActiveTerminalVisibleText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const store = window.__store
    const state = store?.getState()
    const worktreeId = state?.activeWorktreeId
    const tabId =
      state?.activeTabType === 'terminal'
        ? state.activeTabId
        : worktreeId
          ? (state?.activeTabIdByWorktree?.[worktreeId] ?? null)
          : null
    const manager = tabId ? window.__paneManagers?.get(tabId) : null
    const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0] ?? null
    if (!pane) {
      throw new Error('Active terminal pane unavailable')
    }
    const buffer = pane.terminal.buffer.active
    return Array.from({ length: pane.terminal.rows }, (_, row) => {
      const line = buffer.getLine(buffer.viewportY + row)
      return line?.translateToString(true) ?? ''
    }).join('\n')
  })
}

async function forceDarkTerminalRendererPath(page: Page): Promise<void> {
  await page.evaluate(() => {
    const store = window.__store
    if (!store) {
      throw new Error('window.__store unavailable')
    }
    const state = store.getState()
    store.setState({
      settings: {
        ...state.settings!,
        terminalGpuAcceleration: 'auto',
        theme: 'dark'
      }
    })
    const worktreeId = state.activeWorktreeId
    const tabId =
      state.activeTabType === 'terminal'
        ? state.activeTabId
        : worktreeId
          ? (state.activeTabIdByWorktree?.[worktreeId] ?? null)
          : null
    const manager = tabId ? window.__paneManagers?.get(tabId) : null
    manager?.setTerminalGpuAcceleration('auto')
  })
  await page.waitForTimeout(250)
}

async function readTerminalRightEdgeOverpaint(page: Page): Promise<{
  screenRight: number
  offenderCount: number
  offenders: { text: string; right: number; width: number }[]
}> {
  return page.evaluate(() => {
    const store = window.__store
    const state = store?.getState()
    const worktreeId = state?.activeWorktreeId
    const tabId =
      state?.activeTabType === 'terminal'
        ? state.activeTabId
        : worktreeId
          ? (state?.activeTabIdByWorktree?.[worktreeId] ?? null)
          : null
    const manager = tabId ? window.__paneManagers?.get(tabId) : null
    const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0] ?? null
    const screen = pane?.container.querySelector<HTMLElement>('.xterm-screen')
    const rows = pane?.container.querySelector<HTMLElement>('.xterm-rows')
    if (!pane || !screen) {
      throw new Error('Active terminal DOM unavailable')
    }

    const screenRect = screen.getBoundingClientRect()
    if (!rows) {
      // Why: WebGL renders rows into a canvas; DOM-span overpaint checks only
      // apply to the DOM renderer, while buffer wrap checks still run below.
      return {
        screenRight: screenRect.right,
        offenderCount: 0,
        offenders: []
      }
    }

    const cellWidth = pane.terminal._core?._renderService?.dimensions?.css?.cell?.width ?? 0
    const maxRight = screenRect.right + Math.max(1, cellWidth * 0.5)
    const offenders = Array.from(rows.querySelectorAll<HTMLElement>('span'))
      .map((span) => {
        const rect = span.getBoundingClientRect()
        return {
          text: span.textContent ?? '',
          right: rect.right,
          width: rect.width
        }
      })
      .filter((span) => span.width > 0 && span.right > maxRight)
      .slice(0, 12)

    return {
      screenRight: screenRect.right,
      offenderCount: offenders.length,
      offenders
    }
  })
}

async function readTerminalBoxTableWrapDiagnostics(page: Page): Promise<{
  cols: number
  rows: number
  baseY: number
  viewportY: number
  wrappedBoxLines: { index: number; text: string }[]
  nearSinger: { index: number; isWrapped: boolean; text: string }[]
}> {
  return page.evaluate(() => {
    const store = window.__store
    const state = store?.getState()
    const worktreeId = state?.activeWorktreeId
    const tabId =
      state?.activeTabType === 'terminal'
        ? state.activeTabId
        : worktreeId
          ? (state?.activeTabIdByWorktree?.[worktreeId] ?? null)
          : null
    const manager = tabId ? window.__paneManagers?.get(tabId) : null
    const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0] ?? null
    if (!pane) {
      throw new Error('Active terminal pane unavailable')
    }
    const buffer = pane.terminal.buffer.active
    const lineCount = buffer.baseY + buffer.length
    const lines = Array.from({ length: lineCount }, (_, index) => {
      const line = buffer.getLine(index)
      return {
        index,
        isWrapped: line?.isWrapped === true,
        text: line?.translateToString(true) ?? ''
      }
    })
    const wrappedBoxLines = lines
      .filter((line) => line.isWrapped && /[┌┬┐├┼┤└┴┘│─]/.test(line.text))
      .slice(0, 20)
    const singerIndex = lines.findIndex((line) => line.text.includes('Singer'))
    const nearSinger =
      singerIndex === -1 ? [] : lines.slice(Math.max(0, singerIndex - 4), singerIndex + 7)
    return {
      cols: pane.terminal.cols,
      rows: pane.terminal.rows,
      baseY: buffer.baseY,
      viewportY: buffer.viewportY,
      wrappedBoxLines,
      nearSinger
    }
  })
}

async function closeFeatureTips(page: Page): Promise<void> {
  await page.evaluate(() => {
    const store = window.__store
    store?.getState().markFeatureTipsSeen(['orca-cli', 'cmd-j-palette', 'voice-dictation'])
    if (store?.getState().activeModal === 'feature-tips') {
      store.getState().closeModal()
    }
  })
}

async function readTerminalRenderDiagnostics(page: Page): Promise<TerminalRenderDiagnostics> {
  return page.evaluate(() => {
    const store = window.__store
    const state = store?.getState()
    const worktreeId = state?.activeWorktreeId
    const tabId =
      state?.activeTabType === 'terminal'
        ? state.activeTabId
        : worktreeId
          ? (state?.activeTabIdByWorktree?.[worktreeId] ?? null)
          : null
    const manager = tabId ? window.__paneManagers?.get(tabId) : null
    const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0] ?? null
    if (!pane) {
      throw new Error('Active terminal pane unavailable')
    }
    const buffer = pane.terminal.buffer.active
    const visibleLineTails: string[] = []
    for (let row = 0; row < pane.terminal.rows; row += 1) {
      const line = buffer.getLine(buffer.viewportY + row)
      visibleLineTails.push(line?.translateToString(true).slice(-48) ?? '')
    }
    const terminalCore = (
      pane.terminal as unknown as {
        _core?: { coreService?: { isCursorHidden?: boolean } }
      }
    )._core
    const allPaneStates = Array.from(window.__paneManagers?.entries?.() ?? []).flatMap(
      ([managerTabId, paneManager]) =>
        (paneManager.getPanes?.() ?? []).map((managedPane) => {
          const visibleText = Array.from({ length: managedPane.terminal.rows }, (_, row) => {
            const line = managedPane.terminal.buffer.active.getLine(
              managedPane.terminal.buffer.active.viewportY + row
            )
            return line?.translateToString(true) ?? ''
          }).join('\n')
          const serializedText = managedPane.serializeAddon?.serialize?.() ?? visibleText
          return {
            tabId: managerTabId,
            paneId: managedPane.id,
            hasComplexScriptOutput: managedPane.hasComplexScriptOutput === true,
            hasMarker: serializedText.includes('LONG_TABLE_SCROLL_RESTORE_'),
            hasWebgl: Boolean(managedPane.webglAddon)
          }
        })
    )
    return {
      cols: pane.terminal.cols,
      rows: pane.terminal.rows,
      viewportY: buffer.viewportY,
      baseY: buffer.baseY,
      hasComplexScriptOutput: pane.hasComplexScriptOutput === true,
      hasWebgl: Boolean(pane.webglAddon),
      canvasCount: pane.container.querySelectorAll('canvas').length,
      cursorHidden: terminalCore?.coreService?.isCursorHidden ?? null,
      visibleLineTails,
      allPaneStates
    }
  })
}

test.describe('Terminal long table scroll restore repro', () => {
  test('reproduces long markdown table artifacts after workspace switch and scroll', async ({
    orcaPage,
    testRepoPath
  }, testInfo: TestInfo) => {
    await waitForSessionReady(orcaPage)
    await orcaPage.evaluate(() => {
      window.__store
        ?.getState()
        .markFeatureTipsSeen(['orca-cli', 'cmd-j-palette', 'voice-dictation'])
      ;(window as LongTableDebugWindow).__terminalPtyOutputDebug?.reset()
    })
    const firstWorktreeId = await waitForActiveWorktree(orcaPage)
    const secondWorktreeId = (await getAllWorktreeIds(orcaPage)).find(
      (id) => id !== firstWorktreeId
    )
    test.skip(!secondWorktreeId, 'long table restore repro needs the seeded secondary worktree')
    if (!secondWorktreeId) {
      return
    }

    await ensureTerminalVisible(orcaPage)
    await waitForActiveTerminalManager(orcaPage, 30_000)
    const ptyId = await waitForActivePanePtyId(orcaPage)
    await waitForPtyShellEcho(orcaPage, ptyId, 15_000)
    const runId = randomUUID()
    const marker = `LONG_TABLE_SCROLL_RESTORE_${runId}`
    const scriptPath = path.join(testRepoPath, `.orca-long-table-${runId}.mjs`)
    writeFileSync(scriptPath, longMarkdownTableScript(runId))

    try {
      await sendToTerminal(orcaPage, ptyId, `${nodeTerminalCommand([scriptPath])}\r`)
      await orcaPage.waitForTimeout(80)
      await switchToWorktree(orcaPage, secondWorktreeId)
      await waitForActiveTerminalManager(orcaPage, 30_000)
      await orcaPage.waitForTimeout(1_500)
      await switchToWorktree(orcaPage, firstWorktreeId)
      await ensureTerminalVisible(orcaPage)
      await waitForActiveTerminalManager(orcaPage, 30_000)
      await expect
        .poll(() => getTerminalContent(orcaPage, 30_000), {
          timeout: 10_000,
          message: 'long table marker did not survive workspace switch'
        })
        .toContain(marker)

      await scrollActiveTerminalLikeUser(orcaPage)
      await closeFeatureTips(orcaPage)
      const diagnostics = await readTerminalRenderDiagnostics(orcaPage)
      const hiddenDebug = await orcaPage.evaluate(() =>
        (window as LongTableDebugWindow).__terminalPtyOutputDebug?.snapshot()
      )
      expect(hiddenDebug?.hiddenRendererSkipCount).toBe(0)
      const restoredPane = diagnostics.allPaneStates.find((paneState) => paneState.hasMarker)
      expect(restoredPane).toBeDefined()
      expect(diagnostics.cursorHidden).toBe(false)
      await orcaPage.waitForTimeout(100)
      const screenshotPath = testInfo.outputPath('long-table-after-switch-scroll.png')
      await orcaPage.screenshot({ path: screenshotPath, fullPage: true })
      await testInfo.attach('long-table-after-switch-scroll.png', {
        path: screenshotPath,
        contentType: 'image/png'
      })
    } finally {
      rmSync(scriptPath, { force: true })
    }
  })

  test('keeps narrow wrapped signer markdown table coherent after restore and scroll', async ({
    orcaPage,
    testRepoPath
  }, testInfo: TestInfo) => {
    await waitForSessionReady(orcaPage)
    await orcaPage.evaluate(() => {
      window.__store
        ?.getState()
        .markFeatureTipsSeen(['orca-cli', 'cmd-j-palette', 'voice-dictation'])
      ;(window as LongTableDebugWindow).__terminalPtyOutputDebug?.reset()
    })
    const firstWorktreeId = await waitForActiveWorktree(orcaPage)
    const secondWorktreeId = (await getAllWorktreeIds(orcaPage)).find(
      (id) => id !== firstWorktreeId
    )
    test.skip(!secondWorktreeId, 'narrow signer table repro needs the seeded secondary worktree')
    if (!secondWorktreeId) {
      return
    }

    await setRenderedTableViewport(orcaPage)
    await forceDarkTerminalRendererPath(orcaPage)
    await ensureTerminalVisible(orcaPage)
    await waitForActiveTerminalManager(orcaPage, 30_000)
    const ptyId = await waitForActivePanePtyId(orcaPage)
    await waitForPtyShellEcho(orcaPage, ptyId, 15_000)
    const runId = randomUUID()
    const marker = `NARROW_SIGNER_TABLE_RESTORE_${runId}`
    const scriptPath = path.join(testRepoPath, `.orca-narrow-signer-table-${runId}.mjs`)
    writeFileSync(scriptPath, narrowSignerMarkdownTableScript(runId))

    try {
      await sendToTerminal(orcaPage, ptyId, `${nodeTerminalCommand([scriptPath])}\r`)
      await orcaPage.waitForTimeout(80)
      await switchToWorktree(orcaPage, secondWorktreeId)
      await waitForActiveTerminalManager(orcaPage, 30_000)
      await orcaPage.waitForTimeout(1_000)
      await switchToWorktree(orcaPage, firstWorktreeId)
      await ensureTerminalVisible(orcaPage)
      await waitForActiveTerminalManager(orcaPage, 30_000)
      await expect
        .poll(() => getTerminalContent(orcaPage, 30_000), {
          timeout: 10_000,
          message: 'narrow signer table marker did not survive workspace switch'
        })
        .toContain(marker)

      await scrollActiveTerminalLikeUser(orcaPage)
      await closeFeatureTips(orcaPage)
      const diagnostics = await readTerminalRenderDiagnostics(orcaPage)
      const hiddenDebug = await orcaPage.evaluate(() =>
        (window as LongTableDebugWindow).__terminalPtyOutputDebug?.snapshot()
      )
      expect(hiddenDebug?.hiddenRendererSkipCount).toBe(0)
      // Why: renderer cell metrics can land one column wider in headless runs;
      // the content and screenshot assertions below cover the actual regression.
      expect(diagnostics.cols).toBeLessThanOrEqual(112)
      expect(diagnostics.cursorHidden).toBe(false)

      const content = await getTerminalContent(orcaPage, 30_000)
      expect(content).toContain('Signer')
      expect(content).toContain('did:key:z6Mkuw5kQqz1QvZ9f3d2aB7f19f0cAC7B4F3c9E725')
      expect(content).toContain(marker)

      const screenshotPath = testInfo.outputPath('narrow-signer-table-after-switch-scroll.png')
      await orcaPage.screenshot({ path: screenshotPath, fullPage: true })
      await testInfo.attach('narrow-signer-table-after-switch-scroll.png', {
        path: screenshotPath,
        contentType: 'image/png'
      })
    } finally {
      rmSync(scriptPath, { force: true })
    }
  })

  // Why: keeps the user-shaped markdown path covered in the broader e2e suite;
  // the faster raw-table spec is the release-blocking golden for this bug.
  test('keeps real emoji markdown table right edge clean after restore and scroll', async ({
    orcaPage,
    testRepoPath
  }, testInfo: TestInfo) => {
    await waitForSessionReady(orcaPage)
    await closeFeatureTips(orcaPage)
    await orcaPage.evaluate(() => {
      window.__store
        ?.getState()
        .markFeatureTipsSeen(['orca-cli', 'cmd-j-palette', 'voice-dictation'])
      ;(window as LongTableDebugWindow).__terminalPtyOutputDebug?.reset()
    })
    const firstWorktreeId = await waitForActiveWorktree(orcaPage)
    const secondWorktreeId = (await getAllWorktreeIds(orcaPage)).find(
      (id) => id !== firstWorktreeId
    )
    test.skip(!secondWorktreeId, 'real emoji table repro needs the seeded secondary worktree')
    if (!secondWorktreeId) {
      return
    }

    await ensureTerminalVisible(orcaPage)
    await waitForActiveTerminalManager(orcaPage, 30_000)
    await setNarrowTerminalViewport(orcaPage)
    const renderedTableTerminalCols = await waitForRenderedTerminalColumnsAtMost(
      orcaPage,
      NARROW_TERMINAL_MAX_COLS
    )
    const ptyId = await waitForActivePanePtyId(orcaPage)
    await waitForPtyColumnsAtMost(orcaPage, ptyId, renderedTableTerminalCols)
    const runId = randomUUID()
    const marker = `EMOJI_FIXTURE_TABLE_RESTORE_${runId}`
    const scriptPath = path.join(testRepoPath, `.orca-emoji-fixture-table-${runId}.mjs`)
    writeFileSync(scriptPath, emojiFixtureMarkdownTableScript(EMOJI_TABLE_FIXTURE, runId))

    try {
      await sendToTerminal(orcaPage, ptyId, `${nodeTerminalCommand([scriptPath])}\r`)
      await orcaPage.waitForTimeout(80)
      await switchToWorktree(orcaPage, secondWorktreeId)
      await waitForActiveTerminalManager(orcaPage, 30_000)
      await orcaPage.waitForTimeout(1_000)
      await switchToWorktree(orcaPage, firstWorktreeId)
      // Why: worktree activation can restore the right sidebar. This repro is
      // intentionally narrow, but it must stay wide enough for its generated table.
      await ensureTerminalVisible(orcaPage)
      await waitForActiveTerminalManager(orcaPage, 30_000)
      await setNarrowTerminalViewport(orcaPage)
      await waitForRenderedTerminalColumnsAtMost(orcaPage, NARROW_TERMINAL_MAX_COLS)
      await expect
        .poll(() => getTerminalContent(orcaPage, 30_000), {
          timeout: 10_000,
          message: 'real emoji table marker did not survive workspace switch'
        })
        .toContain(marker)
      const generatedWidthContent = await getTerminalContent(orcaPage, 30_000)
      const generatedWidthMatch = generatedWidthContent.match(
        new RegExp(`${emojiFixtureTableWidthMarker(runId)}(\\d+)`)
      )
      expect(generatedWidthMatch).not.toBeNull()
      const generatedTableWidth = Number(generatedWidthMatch?.[1] ?? 0)

      // Why: rows near the top of this heavily wrapped table can fall out of
      // xterm scrollback on CI, and narrow columns split names like "Peacock"
      // across terminal lines. A lower cell fragment still exercises the
      // restored markdown-table viewport without depending on early output.
      const retainedEmojiCell = 'Peac'
      await scrollActiveTerminalToText(orcaPage, retainedEmojiCell)
      await closeFeatureTips(orcaPage)
      await expect
        .poll(() => readActiveTerminalVisibleText(orcaPage), {
          timeout: 5_000,
          message: `${retainedEmojiCell} row fragment should be visible before screenshot`
        })
        .toContain(retainedEmojiCell)
      const diagnostics = await readTerminalRenderDiagnostics(orcaPage)
      const overpaint = await readTerminalRightEdgeOverpaint(orcaPage)
      const wrapDiagnostics = await readTerminalBoxTableWrapDiagnostics(orcaPage)
      const hiddenDebug = await orcaPage.evaluate(() =>
        (window as LongTableDebugWindow).__terminalPtyOutputDebug?.snapshot()
      )
      expect(hiddenDebug?.hiddenRendererSkipCount).toBe(0)
      expect(diagnostics.cols).toBeLessThanOrEqual(NARROW_TERMINAL_MAX_COLS)
      expect(wrapDiagnostics.cols).toBeGreaterThanOrEqual(generatedTableWidth)
      expect(diagnostics.cursorHidden).toBe(false)
      testInfo.annotations.push({
        type: 'real-emoji-table-overpaint',
        description: JSON.stringify(overpaint)
      })
      testInfo.annotations.push({
        type: 'real-emoji-table-wrap-diagnostics',
        description: JSON.stringify(wrapDiagnostics)
      })

      const screenshotPath = testInfo.outputPath('real-emoji-table-after-switch-scroll.png')
      await orcaPage.screenshot({ path: screenshotPath, fullPage: true })
      await testInfo.attach('real-emoji-table-after-switch-scroll.png', {
        path: screenshotPath,
        contentType: 'image/png'
      })
      expect(overpaint.offenders).toEqual([])
      expect(wrapDiagnostics.wrappedBoxLines).toEqual([])
    } finally {
      rmSync(scriptPath, { force: true })
    }
  })
})
