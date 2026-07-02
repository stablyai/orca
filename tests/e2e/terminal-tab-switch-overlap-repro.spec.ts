import { writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Page, TestInfo } from '@stablyai/playwright-test'
import { PNG } from 'pngjs'
import { test, expect } from './helpers/orca-app'
import {
  ensureTerminalVisible,
  getActiveTabId,
  getActiveWorktreeId,
  waitForActiveWorktree,
  waitForSessionReady
} from './helpers/store'
import {
  getTerminalContent,
  sendToTerminal,
  waitForActiveTerminalManager
} from './helpers/terminal'
import {
  restoreFiveHundredMillisecondTimeouts,
  STRETCHED_HIDDEN_OUTPUT_FALLBACK_MS,
  stretchFiveHundredMillisecondTimeouts
} from './terminal-recovery-timeout-stretch'
import {
  instrumentTabResetCounters,
  readTabResetCount,
  readTabResetSnapshot,
  setVisibilityRecoverySuppressed
} from './terminal-recovery-reset-counters'
import { compareTerminalScreenshots } from './terminal-screenshot-diff'

const TAB_A_MARKER = 'ORCA_OVERLAP_REPRO_TAB_A_ONLY'
const TAB_B_MARKER = 'ORCA_OVERLAP_REPRO_TAB_B_ONLY'
const TAB_B_GLYPHS = 'ZYXWVUTSRQPONMLKJIHGFEDCBA 9876543210 !?^"\'();:,.|$_-'
const TAB_B_COLOR = { red: 255, green: 75, blue: 170 }
const VISUAL_OVERLAP_PROBE_CYCLES = 140
const SIBLING_COLOR_PIXEL_FLOOR = 150
const SIBLING_COLOR_PIXEL_DELTA = 100
const REVEAL_RECOVERY_TIMEOUT_MS = 180
const REAL_CLAUDE_PROBE_CYCLES = 160
const REFRESH_REPAIR_DIFF_RATIO = 0.035

type TabIdentity = {
  tabId: string
  leafId: string
  ptyId: string
}

type TabBufferProbe = {
  containsOwnMarker: boolean
  containsSiblingMarker: boolean
  visibleText: string
}

type RefreshRepairProbe = {
  diffRatio: number
  diffPixels: number
  bufferUnchanged: boolean
  beforeText: string
  afterText: string
  beforeScreenshot: Buffer
  afterScreenshot: Buffer
}

type HiddenOutputWindow = Window & {
  __terminalPtyDataInjection?: {
    inject: (paneKey: string, data: string, meta?: { seq?: number; rawLength?: number }) => boolean
  }
}

async function setTerminalGpuOn(page: Page): Promise<void> {
  await page.evaluate(() => {
    const store = window.__store
    const state = store?.getState()
    if (!store || !state?.settings) {
      throw new Error('Store unavailable')
    }
    store.setState({
      settings: {
        ...state.settings,
        terminalGpuAcceleration: 'on'
      }
    })
  })
}

async function ensureTwoTerminalTabs(
  page: Page
): Promise<{ firstTabId: string; secondTabId: string }> {
  const worktreeId = (await getActiveWorktreeId(page))!
  const result = await page.evaluate((worktreeId) => {
    const store = window.__store
    if (!store) {
      throw new Error('Store unavailable')
    }
    const state = store.getState()
    const existing = state.tabsByWorktree[worktreeId] ?? []
    const first = existing.find((tab) => tab.type === 'terminal') ?? state.createTab(worktreeId)
    let second = existing.find((tab) => tab.type === 'terminal' && tab.id !== first.id)
    if (!second) {
      second = state.createTab(worktreeId, undefined, undefined, { activate: false })
    }
    state.setActiveTab(first.id)
    state.setActiveTabType('terminal')
    return { firstTabId: first.id, secondTabId: second.id }
  }, worktreeId)
  await waitForTerminalManagerOnTab(page, result.firstTabId)
  await waitForTerminalManagerOnTab(page, result.secondTabId)
  return result
}

async function ensureThreeTerminalTabs(
  page: Page
): Promise<{ firstTabId: string; secondTabId: string; thirdTabId: string }> {
  const worktreeId = (await getActiveWorktreeId(page))!
  const result = await page.evaluate((worktreeId) => {
    const store = window.__store
    if (!store) {
      throw new Error('Store unavailable')
    }
    const state = store.getState()
    const terminalTabs = (state.tabsByWorktree[worktreeId] ?? []).filter(
      (tab) => tab.type === 'terminal'
    )
    const first = terminalTabs[0] ?? state.createTab(worktreeId)
    const second =
      terminalTabs.find((tab) => tab.id !== first.id) ??
      state.createTab(worktreeId, undefined, undefined, { activate: false })
    const third =
      terminalTabs.find((tab) => tab.id !== first.id && tab.id !== second.id) ??
      state.createTab(worktreeId, undefined, undefined, { activate: false })
    state.setActiveTab(first.id)
    state.setActiveTabType('terminal')
    return { firstTabId: first.id, secondTabId: second.id, thirdTabId: third.id }
  }, worktreeId)
  await waitForTerminalManagerOnTab(page, result.firstTabId)
  await waitForTerminalManagerOnTab(page, result.secondTabId)
  await waitForTerminalManagerOnTab(page, result.thirdTabId)
  return result
}

async function waitForTerminalManagerOnTab(page: Page, tabId: string): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate((tabId) => {
          const manager = window.__paneManagers?.get(tabId)
          return Boolean(manager?.getActivePane?.() ?? manager?.getPanes?.()[0])
        }, tabId),
      { timeout: 15_000, message: `terminal manager did not mount for ${tabId}` }
    )
    .toBe(true)
}

async function activateTerminalTab(page: Page, tabId: string): Promise<void> {
  await page.evaluate((tabId) => {
    const state = window.__store?.getState()
    state?.setActiveTab(tabId)
    state?.setActiveTabType('terminal')
  }, tabId)
  await expect
    .poll(
      () =>
        page
          .locator(`[data-testid="sortable-tab"][data-active="true"]`)
          .getAttribute('data-tab-id'),
      { timeout: 5_000, message: `terminal tab ${tabId} did not become active` }
    )
    .toBe(tabId)
}

async function waitForWebglOnTab(page: Page, tabId: string): Promise<boolean> {
  await page.evaluate((tabId) => {
    window.__paneManagers?.get(tabId)?.setTerminalGpuAcceleration?.('on')
  }, tabId)
  return page
    .waitForFunction(
      (tabId) => {
        const diagnostics = window.__paneManagers?.get(tabId)?.getRenderingDiagnostics?.() ?? []
        return diagnostics.some((entry) => entry.hasWebgl)
      },
      tabId,
      { timeout: 15_000 }
    )
    .then(() => true)
    .catch(() => false)
}

async function readTabIdentity(page: Page, tabId: string): Promise<TabIdentity> {
  await expect
    .poll(
      () =>
        page.evaluate((tabId) => {
          const manager = window.__paneManagers?.get(tabId)
          const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0] ?? null
          return pane?.container.dataset.ptyId ?? null
        }, tabId),
      { timeout: 20_000, message: `terminal tab ${tabId} did not bind a PTY` }
    )
    .not.toBeNull()
  const identity = await page.evaluate((tabId) => {
    const manager = window.__paneManagers?.get(tabId)
    const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0] ?? null
    if (!pane) {
      return null
    }
    return {
      tabId,
      leafId: pane.container.dataset.leafId ?? null,
      ptyId: pane.container.dataset.ptyId ?? null
    }
  }, tabId)
  if (!identity?.leafId || !identity.ptyId) {
    throw new Error(`terminal tab ${tabId} did not bind a PTY`)
  }
  return identity
}

async function readTabBufferProbe(
  page: Page,
  tabId: string,
  ownMarker: string,
  siblingMarker: string
): Promise<TabBufferProbe> {
  return page.evaluate(
    ({ tabId, ownMarker, siblingMarker }) => {
      const manager = window.__paneManagers?.get(tabId)
      const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0] ?? null
      if (!pane) {
        throw new Error(`No terminal pane for ${tabId}`)
      }
      const activeBuffer = pane.terminal.buffer.active
      const rows: string[] = []
      for (let row = 0; row < pane.terminal.rows; row += 1) {
        rows.push(activeBuffer.getLine(activeBuffer.viewportY + row)?.translateToString(true) ?? '')
      }
      const visibleText = rows.join('\n')
      return {
        containsOwnMarker: visibleText.includes(ownMarker),
        containsSiblingMarker: visibleText.includes(siblingMarker),
        visibleText
      }
    },
    { tabId, ownMarker, siblingMarker }
  )
}

async function startTuiStream(
  page: Page,
  ptyId: string,
  scriptPath: string,
  marker: string,
  glyphs: string,
  color: { red: number; green: number; blue: number },
  cadenceMs: number
): Promise<void> {
  const script = [
    `const marker=${JSON.stringify(marker)};`,
    `const glyphs=${JSON.stringify(glyphs)};`,
    `const color=${JSON.stringify(color)};`,
    `const cadence=${cadenceMs};`,
    'let frame=0;',
    'function bar(width){return "█".repeat((frame % width) + 1) + "░".repeat(width - ((frame % width) + 1));}',
    'function paint(text){return `\\x1b[38;2;${color.red};${color.green};${color.blue}m${text}\\x1b[0m`; }',
    'function emit(){',
    '  const lines=[];',
    '  lines.push("\\x1b[?2026h");',
    '  lines.push("\\x1b[?1049h");',
    '  lines.push("\\x1b[2J\\x1b[H\\x1b[?25l");',
    '  lines.push(paint(`╭────────────────────────────────────────────────────────────────────╮`));',
    '  lines.push(paint(`│ ${marker} frame ${String(frame).padStart(4,"0")} ${bar(18)}       │`));',
    '  lines.push(paint(`├────────────────────────────────────────────────────────────────────┤`));',
    '  for (let row=0; row<18; row++) {',
    '    lines.push(paint(`│ row ${String(row).padStart(2,"0")} ${glyphs} ${bar(10)} │`));',
    '  }',
    '  lines.push(paint(`╰────────────────────────────────────────────────────────────────────╯`));',
    '  lines.push("\\x1b[?25h\\x1b[?2026l");',
    '  process.stdout.write(lines.join("\\r\\n"));',
    '  frame += 1;',
    '}',
    'emit();',
    'setInterval(emit, cadence);'
  ].join('')
  writeFileSync(scriptPath, script)
  await sendToTerminal(page, ptyId, `node ${JSON.stringify(scriptPath)}\r`)
}

async function writeSparsePromptFrame(
  page: Page,
  ptyId: string,
  scriptPath: string
): Promise<void> {
  const script = [
    `const marker=${JSON.stringify(TAB_A_MARKER)};`,
    'process.stdout.write("\\x1b[2J\\x1b[3J\\x1b[H\\x1b[?25h");',
    'process.stdout.write(`${marker}\\r\\n`);',
    'process.stdout.write("Please make more to 5 more different random files. Explore orca a bit actually, then do it.   BBB\\r\\n");'
  ].join('')
  writeFileSync(scriptPath, script)
  await sendToTerminal(page, ptyId, `node ${JSON.stringify(scriptPath)}\r`)
}

async function writeDenseStaticFrame(
  page: Page,
  ptyId: string,
  scriptPath: string,
  marker: string
): Promise<void> {
  const script = [
    `const marker=${JSON.stringify(marker)};`,
    'const glyphs="ABCDEFGHIJKLMNOPQRSTUVWXYZ abcdefghijklmnopqrstuvwxyz 0123456789 []{}<>/\\\\#@%&*+=~";',
    'process.stdout.write("\\x1b[2J\\x1b[3J\\x1b[H\\x1b[?25l");',
    'for (let row = 0; row < 22; row += 1) {',
    '  process.stdout.write(`${marker} row ${String(row).padStart(2, "0")} | ${glyphs} |\\r\\n`);',
    '}'
  ].join('')
  writeFileSync(scriptPath, script)
  await sendToTerminal(page, ptyId, `node ${JSON.stringify(scriptPath)}\r`)
}

async function injectHiddenTuiFrame(
  page: Page,
  identity: TabIdentity,
  marker: string
): Promise<void> {
  const paneKey = `${identity.tabId}:${identity.leafId}`
  const frame = [
    '\x1b[?2026h',
    '\x1b[?1049h',
    '\x1b[2J\x1b[H\x1b[?25l',
    `╭────────────────────────────────────────────────────────╮`,
    `│ ${marker} hidden atlas recovery frame                  │`,
    `├────────────────────────────────────────────────────────┤`,
    ...Array.from(
      { length: 12 },
      (_, row) => `│ hidden row ${String(row).padStart(2, '0')} ███████████████████ │`
    ),
    `╰────────────────────────────────────────────────────────╯`,
    '\x1b[?25h\x1b[?2026l'
  ].join('\r\n')
  const injected = await page.evaluate(
    ({ paneKey, frame }) =>
      (window as HiddenOutputWindow).__terminalPtyDataInjection?.inject(paneKey, frame, {
        seq: frame.length,
        rawLength: frame.length
      }) ?? false,
    { paneKey, frame }
  )
  if (!injected) {
    throw new Error(`No terminal PTY data injector registered for ${paneKey}`)
  }
}

async function corruptTabAtlas(page: Page, tabId: string): Promise<number> {
  return page.evaluate((tabId) => {
    const manager = window.__paneManagers?.get(tabId)
    const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0] ?? null
    if (!pane) {
      return 0
    }
    const canvases = Array.from(
      document.querySelectorAll<HTMLCanvasElement>(`[data-terminal-tab-id="${tabId}"] canvas`)
    )
    const noise = new Uint8Array(64 * 64 * 4)
    for (let index = 0; index < noise.length; index += 4) {
      noise[index] = (index * 7) % 256
      noise[index + 1] = (index * 13) % 256
      noise[index + 2] = (index * 29) % 256
      noise[index + 3] = 255
    }
    let corrupted = 0
    for (const canvas of canvases) {
      const gl =
        (canvas.getContext('webgl2') as WebGL2RenderingContext | null) ??
        (canvas.getContext('webgl') as WebGLRenderingContext | null)
      if (!gl) {
        continue
      }
      const maxUnits = gl.getParameter(gl.MAX_COMBINED_TEXTURE_IMAGE_UNITS) as number
      for (let unit = 0; unit < maxUnits; unit += 1) {
        gl.activeTexture(gl.TEXTURE0 + unit)
        if (!gl.getParameter(gl.TEXTURE_BINDING_2D)) {
          continue
        }
        for (const [x, y] of [
          [0, 0],
          [64, 0],
          [128, 0],
          [192, 0],
          [0, 64],
          [64, 64],
          [128, 64],
          [192, 64]
        ]) {
          gl.texSubImage2D(gl.TEXTURE_2D, 0, x, y, 64, 64, gl.RGBA, gl.UNSIGNED_BYTE, noise)
          if (gl.getError() === gl.NO_ERROR) {
            corrupted += 1
          }
        }
        if (corrupted > 0) {
          break
        }
      }
      gl.activeTexture(gl.TEXTURE0)
      if (corrupted > 0) {
        break
      }
    }
    pane.terminal.refresh(0, pane.terminal.rows - 1)
    return corrupted
  }, tabId)
}

async function resetAndRefreshTab(page: Page, tabId: string): Promise<void> {
  await page.evaluate((tabId) => {
    const manager = window.__paneManagers?.get(tabId)
    manager?.resetWebglTextureAtlases?.()
    manager?.refreshAllPanes?.()
  }, tabId)
  await waitForTwoAnimationFrames(page)
}

async function waitForTwoAnimationFrames(page: Page): Promise<void> {
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  )
}

async function captureTabScreen(page: Page, tabId: string): Promise<Buffer> {
  const screen = page.locator(`[data-terminal-tab-id="${tabId}"] .xterm-screen`).first()
  await expect(screen).toBeVisible()
  return screen.screenshot({ animations: 'disabled' })
}

function countColorPixels(
  buffer: Buffer,
  target: { red: number; green: number; blue: number }
): number {
  const image = PNG.sync.read(buffer)
  let pixels = 0
  for (let offset = 0; offset < image.data.length; offset += 4) {
    const alpha = image.data[offset + 3] ?? 0
    if (alpha < 120) {
      continue
    }
    const red = image.data[offset] ?? 0
    const green = image.data[offset + 1] ?? 0
    const blue = image.data[offset + 2] ?? 0
    const distance =
      Math.abs(red - target.red) + Math.abs(green - target.green) + Math.abs(blue - target.blue)
    if (distance <= 95) {
      pixels += 1
    }
  }
  return pixels
}

async function attachArtifact(
  testInfo: TestInfo,
  name: string,
  body: Buffer | string
): Promise<void> {
  await testInfo.attach(name, {
    body: typeof body === 'string' ? Buffer.from(body) : body,
    contentType: typeof body === 'string' ? 'text/plain' : 'image/png'
  })
}

async function refreshActiveTabAndCompare(page: Page, tabId: string): Promise<RefreshRepairProbe> {
  const beforeText = (await readTabBufferProbe(page, tabId, '', '\u0000')).visibleText
  const beforeScreenshot = await captureTabScreen(page, tabId)
  await page.evaluate((tabId) => {
    const manager = window.__paneManagers?.get(tabId)
    const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0] ?? null
    if (!pane) {
      throw new Error(`No terminal pane for ${tabId}`)
    }
    pane.terminal.refresh(0, pane.terminal.rows - 1)
  }, tabId)
  await waitForTwoAnimationFrames(page)
  const afterScreenshot = await captureTabScreen(page, tabId)
  const afterText = (await readTabBufferProbe(page, tabId, '', '\u0000')).visibleText
  const diff = compareTerminalScreenshots(beforeScreenshot, afterScreenshot)
  return {
    diffRatio: diff.diffRatio,
    diffPixels: diff.diffPixels,
    bufferUnchanged: beforeText === afterText,
    beforeText,
    afterText,
    beforeScreenshot,
    afterScreenshot
  }
}

async function startClaudeEditSession(
  page: Page,
  ptyId: string,
  marker: string,
  filePrefix: string
): Promise<void> {
  const prompt = [
    `This is an Orca terminal renderer reproduction run. Marker: ${marker}.`,
    'Create or edit 10 small scratch files in the current repo.',
    `Name them ${filePrefix}-01.txt through ${filePrefix}-10.txt.`,
    'After each file edit, run a tiny shell command that prints the marker and sleep 1 second.',
    'Keep working without asking questions. The visible terminal activity is the point.'
  ].join(' ')
  await sendToTerminal(
    page,
    ptyId,
    `claude --model sonnet --effort low --dangerously-skip-permissions --permission-mode bypassPermissions ${JSON.stringify(prompt)}\r`
  )
}

test.describe('Terminal tab switch visual overlap repro @headful', () => {
  test('manual probe for visible sibling TUI pixels while tab buffers stay isolated', async ({
    orcaPage,
    testRepoPath
  }, testInfo) => {
    test.skip(
      process.env.ORCA_E2E_VISUAL_OVERLAP_PROBE !== '1',
      'Set ORCA_E2E_VISUAL_OVERLAP_PROBE=1 to run the best-effort visual overlap probe'
    )
    test.setTimeout(180_000)
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
    await waitForActiveTerminalManager(orcaPage, 30_000)
    await setTerminalGpuOn(orcaPage)

    const { firstTabId, secondTabId } = await ensureTwoTerminalTabs(orcaPage)
    await activateTerminalTab(orcaPage, firstTabId)
    const firstWebgl = await waitForWebglOnTab(orcaPage, firstTabId)
    const firstIdentity = await readTabIdentity(orcaPage, firstTabId)

    await activateTerminalTab(orcaPage, secondTabId)
    const secondWebgl = await waitForWebglOnTab(orcaPage, secondTabId)
    const secondIdentity = await readTabIdentity(orcaPage, secondTabId)
    test.skip(!firstWebgl || !secondWebgl, 'WebGL did not attach on both regular terminal tabs')

    await writeSparsePromptFrame(
      orcaPage,
      firstIdentity.ptyId,
      path.join(testRepoPath, 'orca-overlap-tab-a-sparse.mjs')
    )
    await startTuiStream(
      orcaPage,
      secondIdentity.ptyId,
      path.join(testRepoPath, 'orca-overlap-tab-b.mjs'),
      TAB_B_MARKER,
      TAB_B_GLYPHS,
      TAB_B_COLOR,
      41
    )

    await activateTerminalTab(orcaPage, firstTabId)
    await expect
      .poll(() => getTerminalContent(orcaPage, 12_000), {
        timeout: 20_000,
        message: 'tab A sparse prompt frame did not reach the visible terminal'
      })
      .toContain(TAB_A_MARKER)
    const baselineA = await captureTabScreen(orcaPage, firstTabId)
    const baselineAHasSiblingColor = countColorPixels(baselineA, TAB_B_COLOR)

    await activateTerminalTab(orcaPage, secondTabId)
    await expect
      .poll(() => getTerminalContent(orcaPage, 12_000), {
        timeout: 20_000,
        message: 'tab B TUI stream did not reach the visible terminal'
      })
      .toContain(`${TAB_B_MARKER} frame`)
    const baselineB = await captureTabScreen(orcaPage, secondTabId)
    const baselineBHasOwnColor = countColorPixels(baselineB, TAB_B_COLOR)
    expect(baselineBHasOwnColor).toBeGreaterThan(500)

    const reports: string[] = []
    for (let cycle = 0; cycle < VISUAL_OVERLAP_PROBE_CYCLES; cycle += 1) {
      await activateTerminalTab(orcaPage, secondTabId)
      await orcaPage.waitForTimeout(15)
      await activateTerminalTab(orcaPage, firstTabId)
      const activeTabId = (await getActiveTabId(orcaPage))!
      const screenshot = await captureTabScreen(orcaPage, activeTabId)
      const probe = await readTabBufferProbe(orcaPage, activeTabId, TAB_A_MARKER, TAB_B_MARKER)
      if (!probe.containsOwnMarker || probe.containsSiblingMarker) {
        reports.push(
          `cycle ${cycle} buffer mismatch active=${activeTabId} own=${probe.containsOwnMarker} sibling=${probe.containsSiblingMarker}`
        )
        await attachArtifact(testInfo, `buffer-mismatch-cycle-${cycle}.txt`, probe.visibleText)
        break
      }
      const siblingColorPixels = countColorPixels(screenshot, TAB_B_COLOR)
      if (
        siblingColorPixels >
        Math.max(SIBLING_COLOR_PIXEL_FLOOR, baselineAHasSiblingColor + SIBLING_COLOR_PIXEL_DELTA)
      ) {
        reports.push(
          `cycle ${cycle} visual sibling color active=${activeTabId} siblingPixels=${siblingColorPixels} baselineSiblingPixels=${baselineAHasSiblingColor} bufferSibling=${probe.containsSiblingMarker}`
        )
        await attachArtifact(testInfo, `overlap-candidate-${cycle}.png`, screenshot)
        await attachArtifact(testInfo, `overlap-buffer-${cycle}.txt`, probe.visibleText)
        break
      }
      await orcaPage.waitForTimeout(20)
    }

    await attachArtifact(testInfo, 'tab-a-baseline.png', baselineA)
    await attachArtifact(testInfo, 'tab-b-baseline.png', baselineB)
    expect(
      reports,
      reports.length > 0
        ? `active terminal showed sibling-colored pixels while buffers stayed isolated:\n${reports.join('\n')}`
        : undefined
    ).toEqual([])
  })

  test('repairs returned tab pixels even while hidden-output recovery is in flight', async ({
    orcaPage,
    testRepoPath
  }, testInfo) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
    await waitForActiveTerminalManager(orcaPage, 30_000)
    await setTerminalGpuOn(orcaPage)

    const { firstTabId, secondTabId, thirdTabId } = await ensureThreeTerminalTabs(orcaPage)
    await activateTerminalTab(orcaPage, firstTabId)
    const firstWebgl = await waitForWebglOnTab(orcaPage, firstTabId)
    const firstIdentity = await readTabIdentity(orcaPage, firstTabId)
    await writeDenseStaticFrame(
      orcaPage,
      firstIdentity.ptyId,
      path.join(testRepoPath, 'orca-overlap-static-a.mjs'),
      'ORCA_DETERMINISTIC_A'
    )
    await expect
      .poll(() => getTerminalContent(orcaPage, 12_000), {
        timeout: 20_000,
        message: 'tab A static frame did not reach the visible terminal'
      })
      .toContain('ORCA_DETERMINISTIC_A row 21')
    await resetAndRefreshTab(orcaPage, firstTabId)
    const baseline = await captureTabScreen(orcaPage, firstTabId)

    const activeCorruptedTiles = await corruptTabAtlas(orcaPage, firstTabId)
    test.skip(activeCorruptedTiles === 0, 'Could not inject WebGL atlas corruption')
    const activeCorruption = await captureTabScreen(orcaPage, firstTabId)
    expect(
      compareTerminalScreenshots(baseline, activeCorruption).matches,
      'atlas corruption precondition should visibly change active tab glyphs'
    ).toBe(false)
    await resetAndRefreshTab(orcaPage, firstTabId)
    const restored = await captureTabScreen(orcaPage, firstTabId)
    expect(compareTerminalScreenshots(baseline, restored).matches).toBe(true)

    await activateTerminalTab(orcaPage, thirdTabId)
    const thirdWebgl = await waitForWebglOnTab(orcaPage, thirdTabId)
    const thirdIdentity = await readTabIdentity(orcaPage, thirdTabId)
    await activateTerminalTab(orcaPage, secondTabId)
    const secondWebgl = await waitForWebglOnTab(orcaPage, secondTabId)
    test.skip(
      !firstWebgl || !secondWebgl || !thirdWebgl,
      'WebGL did not attach on all regular terminal tabs'
    )
    await instrumentTabResetCounters(orcaPage, [firstTabId, secondTabId, thirdTabId])
    await stretchFiveHundredMillisecondTimeouts(orcaPage)
    try {
      await injectHiddenTuiFrame(orcaPage, thirdIdentity, 'ORCA_HIDDEN_OUTPUT_RECOVERY_IN_FLIGHT')
      // Why: the regression is the output-recovery latch suppressing reveal
      // recovery. Prove the hidden-output burst reached its rAF and 120ms passes
      // before reveal, while its old 500ms fallback is stretched out of range.
      await expect
        .poll(() => readTabResetCount(orcaPage, thirdTabId), {
          timeout: 2_000,
          message: 'hidden-output recovery did not fire its first two reset passes'
        })
        .toBeGreaterThanOrEqual(2)
    } finally {
      await restoreFiveHundredMillisecondTimeouts(orcaPage)
    }
    const hiddenOutputResetCount = await readTabResetCount(orcaPage, thirdTabId)
    expect(hiddenOutputResetCount).toBeGreaterThanOrEqual(2)
    expect(
      hiddenOutputResetCount,
      'hidden-output fallback fired before the reveal precondition could be exercised'
    ).toBeLessThanOrEqual(2)
    const hiddenOutputResetWindow = await readTabResetSnapshot(orcaPage, thirdTabId)
    const resetCountBeforeSuppressedReveal = await readTabResetCount(orcaPage, firstTabId)
    expect(resetCountBeforeSuppressedReveal).toBeGreaterThanOrEqual(2)
    expect(
      resetCountBeforeSuppressedReveal,
      'hidden-output fallback fired before tab reveal'
    ).toBeLessThanOrEqual(2)
    let suppressedReveal: Buffer | null = null
    try {
      await setVisibilityRecoverySuppressed(orcaPage, true)
      await activateTerminalTab(orcaPage, firstTabId)
      await waitForTwoAnimationFrames(orcaPage)
      const staleCorruptedTiles = await corruptTabAtlas(orcaPage, firstTabId)
      expect(staleCorruptedTiles).toBeGreaterThan(0)
      suppressedReveal = await captureTabScreen(orcaPage, firstTabId)
      const suppressedRevealDiff = compareTerminalScreenshots(baseline, suppressedReveal)
      expect(
        suppressedRevealDiff.matches,
        'simulated stale returned-tab pixels must be visible when recovery is suppressed'
      ).toBe(false)
      await activateTerminalTab(orcaPage, secondTabId)
      await waitForTwoAnimationFrames(orcaPage)
    } finally {
      await setVisibilityRecoverySuppressed(orcaPage, false)
    }
    const resetCountBeforeReveal = await readTabResetCount(orcaPage, firstTabId)
    expect(resetCountBeforeReveal).toBe(resetCountBeforeSuppressedReveal)
    expect(resetCountBeforeReveal).toBeGreaterThanOrEqual(2)
    expect(
      resetCountBeforeReveal,
      'hidden-output fallback fired before tab reveal'
    ).toBeLessThanOrEqual(2)
    const revealStartedAt = await orcaPage.evaluate(() => performance.now())
    expect(
      revealStartedAt - hiddenOutputResetWindow.latestAt,
      'tab reveal started too close to the stretched hidden-output fallback to prove independent recovery'
    ).toBeLessThan(STRETCHED_HIDDEN_OUTPUT_FALLBACK_MS - REVEAL_RECOVERY_TIMEOUT_MS)
    await activateTerminalTab(orcaPage, firstTabId)
    await expect
      .poll(() => readTabResetCount(orcaPage, firstTabId), {
        timeout: REVEAL_RECOVERY_TIMEOUT_MS,
        message: 'tab reveal did not schedule an independent WebGL recovery reset'
      })
      .toBeGreaterThan(resetCountBeforeReveal)
    const resetAfterReveal = await readTabResetSnapshot(orcaPage, firstTabId)
    expect(
      resetAfterReveal.latestAt - revealStartedAt,
      'reveal recovery must beat the old hidden-output 500ms fallback reset'
    ).toBeLessThan(REVEAL_RECOVERY_TIMEOUT_MS)
    expect(
      resetAfterReveal.latestAt - hiddenOutputResetWindow.latestAt,
      'post-reveal reset must occur before the hidden-output 500ms fallback could explain it'
    ).toBeLessThan(STRETCHED_HIDDEN_OUTPUT_FALLBACK_MS)
    await waitForTwoAnimationFrames(orcaPage)
    const afterReveal = await captureTabScreen(orcaPage, firstTabId)
    const afterRevealDiff = compareTerminalScreenshots(baseline, afterReveal)
    await attachArtifact(testInfo, 'deterministic-baseline.png', baseline)
    await attachArtifact(
      testInfo,
      'deterministic-suppressed-reveal.png',
      suppressedReveal ?? Buffer.from('')
    )
    await attachArtifact(testInfo, 'deterministic-after-reveal.png', afterReveal)
    await attachArtifact(
      testInfo,
      'deterministic-reset-counts.txt',
      `beforeReveal=${resetCountBeforeReveal}\nafterReveal=${resetAfterReveal.count}\nrevealDelayMs=${resetAfterReveal.latestAt - revealStartedAt}\nhiddenSecondResetToRevealMs=${revealStartedAt - hiddenOutputResetWindow.latestAt}\nstretchedHiddenOutputFallbackMs=${STRETCHED_HIDDEN_OUTPUT_FALLBACK_MS}\n`
    )
    expect(
      afterRevealDiff.matches,
      `returned tab still had stale WebGL pixels after reveal: ${afterRevealDiff.diffPixels} px (${(afterRevealDiff.diffRatio * 100).toFixed(2)}%)`
    ).toBe(true)
  })

  test('real Claude sessions do not leave refresh-repairable stale pixels', async ({
    orcaPage
  }, testInfo) => {
    test.skip(
      process.env.ORCA_E2E_REAL_CLAUDE_OVERLAP_REPRO !== '1',
      'Set ORCA_E2E_REAL_CLAUDE_OVERLAP_REPRO=1 to spend real Claude Code tokens on this repro'
    )
    test.setTimeout(420_000)
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
    await waitForActiveTerminalManager(orcaPage, 30_000)
    await setTerminalGpuOn(orcaPage)

    const { firstTabId, secondTabId } = await ensureTwoTerminalTabs(orcaPage)
    await activateTerminalTab(orcaPage, firstTabId)
    const firstWebgl = await waitForWebglOnTab(orcaPage, firstTabId)
    const firstIdentity = await readTabIdentity(orcaPage, firstTabId)
    await activateTerminalTab(orcaPage, secondTabId)
    const secondWebgl = await waitForWebglOnTab(orcaPage, secondTabId)
    const secondIdentity = await readTabIdentity(orcaPage, secondTabId)
    test.skip(!firstWebgl || !secondWebgl, 'WebGL did not attach on both regular terminal tabs')

    await startClaudeEditSession(
      orcaPage,
      firstIdentity.ptyId,
      'ORCA_REAL_CLAUDE_A',
      'orca-real-claude-a'
    )
    await startClaudeEditSession(
      orcaPage,
      secondIdentity.ptyId,
      'ORCA_REAL_CLAUDE_B',
      'orca-real-claude-b'
    )

    const reports: string[] = []
    for (let cycle = 0; cycle < REAL_CLAUDE_PROBE_CYCLES; cycle += 1) {
      const tabId = cycle % 2 === 0 ? firstTabId : secondTabId
      await activateTerminalTab(orcaPage, tabId)
      await orcaPage.waitForTimeout(120)
      const repair = await refreshActiveTabAndCompare(orcaPage, tabId)
      if (repair.bufferUnchanged && repair.diffRatio > REFRESH_REPAIR_DIFF_RATIO) {
        reports.push(
          `cycle ${cycle} tab=${tabId} refresh changed ${(repair.diffRatio * 100).toFixed(2)}% of pixels without buffer change (${repair.diffPixels} px)`
        )
        await attachArtifact(
          testInfo,
          `real-claude-before-refresh-${cycle}.png`,
          repair.beforeScreenshot
        )
        await attachArtifact(
          testInfo,
          `real-claude-after-refresh-${cycle}.png`,
          repair.afterScreenshot
        )
        await attachArtifact(testInfo, `real-claude-buffer-${cycle}.txt`, repair.beforeText)
        break
      }
      await orcaPage.waitForTimeout(500)
    }

    expect(
      reports,
      reports.length > 0
        ? `real Claude terminal surface had refresh-repairable stale pixels:\n${reports.join('\n')}`
        : undefined
    ).toEqual([])
  })
})
