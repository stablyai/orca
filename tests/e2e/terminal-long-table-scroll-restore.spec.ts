import { randomUUID } from 'node:crypto'
import { rmSync, writeFileSync } from 'node:fs'
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
process.stdout.write('\\x1b[?2026h\\x1b[2J\\x1b[H')
let index = 0
const timer = setInterval(() => {
  if (index < outputRows.length) {
    process.stdout.write(outputRows[index] + '\\n')
    index += 1
    return
  }
  clearInterval(timer)
  process.stdout.write('LONG_TABLE_SCROLL_RESTORE_${runId}\\n')
  process.stdout.write('\\x1b[?2026l')
}, 8)
`
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
    const runId = randomUUID()
    const marker = `LONG_TABLE_SCROLL_RESTORE_${runId}`
    const scriptPath = path.join(testRepoPath, `.orca-long-table-${runId}.mjs`)
    writeFileSync(scriptPath, longMarkdownTableScript(runId))

    try {
      await sendToTerminal(orcaPage, ptyId, `node ${JSON.stringify(scriptPath)}\r`)
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
      expect(restoredPane?.hasWebgl).toBe(false)
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
})
