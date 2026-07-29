#!/usr/bin/env node

import { _electron as electron } from '@stablyai/playwright-test'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  createTerminalTab as createPackagedTerminalTab,
  dismissOverlays,
  ensureTerminal,
  focusActiveTerminal
} from './win-update-e2e/app-driver.mjs'
import { createSeededRepo } from './win-update-e2e/onboarding-profile.mjs'
import { recoverProductionTerminalRefs } from './terminal-garble-react-terminal-recovery.mjs'
import {
  analyzeTerminalFrame,
  findPersistentCellDivergences
} from './terminal-garble-frame-analysis.mjs'

const DEFAULT_EXECUTABLE = '/Applications/Orca.app/Contents/MacOS/Orca'
const DEFAULT_PROFILE = path.join(os.homedir(), 'Library', 'Application Support', 'orca')
const URL = 'https://example.com/orca-terminal-garble-repro'
const MODIFIER = process.platform === 'darwin' ? 'Meta' : 'Control'
const replayRoot = path.join(os.tmpdir(), 'garble-rig')
const REPLAY_A = path.join(replayRoot, 'frames-A.jsonl')
const REPLAY_B = path.join(replayRoot, 'frames-B.jsonl')
const REPLAY_SCRIPT = path.resolve('tools/terminal-garble-session-replay.mjs')
const PANE_COUNT = Number(argValue('--panes', '2'))
const TAB_COUNT = Number(argValue('--tabs', '1'))
const CLICK_COUNT = Number(argValue('--clicks', '3'))
const CAPTURE_INTERVAL_MS = 250
const CAPTURE_WINDOW_MS = Number(argValue('--capture-ms', '12000'))
const WARMUP_MS = Number(argValue('--warmup-ms', '8000'))
const APPEARANCE = argValue('--appearance', 'dark')
const glyphChurn = process.argv.includes('--glyph-churn')

function argValue(name, fallback) {
  const prefix = `${name}=`
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length) ?? fallback
}

function quoteShellArgument(value) {
  if (process.platform === 'win32') {
    return `"${value.replaceAll('"', '""')}"`
  }
  return `'${value.replaceAll("'", `'\\''`)}'`
}

const executablePath = argValue('--executable', DEFAULT_EXECUTABLE)
const mainPath = argValue('--main', '')
const sourceProfile = argValue('--profile', DEFAULT_PROFILE)
const keepProfile = process.argv.includes('--keep-profile')
const allowOpenUrl = process.argv.includes('--allow-open-url')
const stubOpenUrl = !allowOpenUrl || process.argv.includes('--stub-open-url')
const stubOpenUrlAfterFirst = process.argv.includes('--stub-open-url-after-first')
const focusChurn = process.argv.includes('--focus-churn')
const runRoot = mkdtempSync(path.join(os.tmpdir(), 'orca-terminal-garble-'))
const userDataDir = path.join(runRoot, 'user-data')
const evidenceDir = path.join(runRoot, 'evidence')
mkdirSync(userDataDir, { recursive: true })
mkdirSync(evidenceDir, { recursive: true })
function sanitizeProfile() {
  const sourceDataPath = path.join(sourceProfile, 'orca-data.json')
  const data = JSON.parse(readFileSync(sourceDataPath, 'utf8'))
  const repo = createSeededRepo(path.join(runRoot, 'fixture-repo'))

  // Why: use the real terminal settings and repo while omitting every persisted
  // session/automation field that could duplicate work from the live profile.
  const profile = {
    settings: { ...data.settings, theme: APPEARANCE },
    onboarding: {
      flowVersion: 4,
      closedAt: Date.now(),
      outcome: 'completed',
      lastCompletedStep: 5
    },
    repos: [repo]
  }
  const serialized = `${JSON.stringify(profile)}\n`
  writeFileSync(path.join(userDataDir, 'orca-data.json'), serialized)

  for (const file of ['Preferences', 'Local State']) {
    const source = path.join(sourceProfile, file)
    if (existsSync(source)) {
      cpSync(source, path.join(userDataDir, file))
    }
  }
}
async function exposeProductionTerminals(page) {
  return page.evaluate(recoverProductionTerminalRefs)
}
async function runInActivePane(page, command) {
  const activePane = page.locator('.pane:has([data-active-pane]):visible').last()
  if (await activePane.isVisible().catch(() => false)) {
    await activePane.click({ position: { x: 20, y: 40 } })
    await activePane.locator('.xterm-helper-textarea').last().focus()
  } else {
    await focusActiveTerminal(page)
  }
  await page.keyboard.type(command, { delay: 1 })
  await page.keyboard.press('Enter')
}
async function configurePanes(page) {
  await page.waitForTimeout(1_000)
  await dismissOverlays(page)
  await ensureTerminal(page, { allowCreate: true, timeoutMs: 90_000 })
  await dismissOverlays(page)
  for (let tab = 0; tab < TAB_COUNT; tab++) {
    if (tab > 0) {
      await createPackagedTerminalTab(page)
    }
    for (let pane = 0; pane < PANE_COUNT; pane++) {
      const frames = (tab + pane) % 2 === 0 ? REPLAY_A : REPLAY_B
      const args = [
        quoteShellArgument(REPLAY_SCRIPT),
        quoteShellArgument(frames),
        '--loop',
        `--tick=${250 + ((tab + pane) % 5) * 20}`,
        `--url=${quoteShellArgument(URL)}`
      ]
      if (glyphChurn) {
        args.push(`--glyph-churn=${tab * PANE_COUNT + pane}`)
      }
      await runInActivePane(page, `node ${args.join(' ')}`)
      if (pane + 1 < PANE_COUNT) {
        await page.keyboard.press(pane % 2 === 0 ? `${MODIFIER}+d` : `${MODIFIER}+Shift+d`)
        await page.waitForTimeout(500)
      }
    }
  }
  await page.waitForTimeout(WARMUP_MS)
}
async function paneGeometry(page) {
  return page.evaluate(() => {
    const exposedManagers = window.__paneManagers
    if (exposedManagers instanceof Map) {
      const managed = []
      for (const manager of exposedManagers.values()) {
        for (const pane of manager.getPanes?.() ?? []) {
          const screen = pane.container?.querySelector('.xterm-screen')
          const bounds = screen?.getBoundingClientRect()
          if (!bounds || bounds.width <= 0 || bounds.height <= 0) {
            continue
          }
          managed.push({
            index: managed.length,
            paneId: pane.id,
            bounds: {
              x: bounds.x,
              y: bounds.y,
              width: bounds.width,
              height: bounds.height
            },
            cell: {
              width: bounds.width / pane.terminal.cols,
              height: bounds.height / pane.terminal.rows
            },
            canvases: screen.querySelectorAll('canvas').length,
            cols: pane.terminal.cols,
            rows: pane.terminal.rows
          })
        }
      }
      if (managed.length > 0) {
        return managed
      }
    }
    const recovered = window.__terminalGarbleTerminals
    if (Array.isArray(recovered)) {
      const managed = recovered
        .filter((terminal) => terminal.element?.offsetWidth && terminal.element?.offsetHeight)
        .map((terminal, index) => {
          const screen = terminal.element?.querySelector('.xterm-screen')
          const bounds = screen?.getBoundingClientRect()
          if (!bounds || bounds.width <= 0 || bounds.height <= 0) {
            return null
          }
          return {
            index,
            bounds: {
              x: bounds.x,
              y: bounds.y,
              width: bounds.width,
              height: bounds.height
            },
            cell: {
              width: bounds.width / terminal.cols,
              height: bounds.height / terminal.rows
            },
            canvases: screen.querySelectorAll('canvas').length,
            cols: terminal.cols,
            rows: terminal.rows
          }
        })
        .filter(Boolean)
      if (managed.length > 0) {
        return managed
      }
    }
    const visible = (element) => {
      const rect = element.getBoundingClientRect()
      return rect.width > 0 && rect.height > 0
    }
    return Array.from(document.querySelectorAll('.xterm-screen'))
      .filter(visible)
      .map((screen, index) => {
        const xterm = screen.closest('.xterm')
        const screenRect = screen.getBoundingClientRect()
        const fontSize = Number.parseFloat(getComputedStyle(xterm ?? screen).fontSize) || 13
        return {
          index,
          bounds: {
            x: screenRect.x,
            y: screenRect.y,
            width: screenRect.width,
            height: screenRect.height
          },
          cell: { width: fontSize * 0.6, height: fontSize * 1.2 },
          canvases: screen.querySelectorAll('canvas').length
        }
      })
      .filter((pane) => pane.cell.width > 0 && pane.cell.height > 0)
  })
}
async function terminalState(page) {
  return page.evaluate(() => {
    const managers = window.__paneManagers
    const recovered = window.__terminalGarbleTerminals
    if (!(managers instanceof Map) && !Array.isArray(recovered)) {
      return { exposed: false, focused: document.hasFocus(), panes: [] }
    }
    const terminalPanes = []
    if (managers instanceof Map) {
      for (const manager of managers.values()) {
        terminalPanes.push(...(manager.getPanes?.() ?? []))
      }
    } else {
      terminalPanes.push(...recovered.map((terminal, index) => ({ id: index, terminal })))
    }
    const panes = []
    for (const pane of terminalPanes) {
      const paneRect = pane.container?.getBoundingClientRect()
      const terminalRect = pane.terminal?.element?.getBoundingClientRect()
      if (
        (!paneRect || paneRect.width <= 0 || paneRect.height <= 0) &&
        (!terminalRect || terminalRect.width <= 0 || terminalRect.height <= 0)
      ) {
        continue
      }
      const terminal = pane.terminal
      const buffer = terminal.buffer.active
      const lines = []
      const textCells = []
      for (let row = 0; row < terminal.rows; row++) {
        const line = buffer.getLine(buffer.viewportY + row)
        lines.push(line?.translateToString(true) ?? '')
        const rowCells = []
        for (let column = 0; column < terminal.cols; column++) {
          const cell = line?.getCell(column)
          const chars = cell?.getChars() ?? ''
          if (chars !== '' && chars !== ' ' && cell?.getWidth() !== 0) {
            rowCells.push([column, chars])
          }
        }
        textCells.push(rowCells)
      }
      const renderService = terminal._core?._renderService
      const renderer = renderService?._renderer?.value
      panes.push({
        paneId: pane.id,
        cols: terminal.cols,
        rows: terminal.rows,
        viewportY: buffer.viewportY,
        paused: renderService?._isPaused === true,
        needsFullRefresh: renderService?._needsFullRefresh === true,
        atlasPages: renderer?._charAtlas?.pages?.length ?? -1,
        bufferText: lines.join('\n'),
        textCells
      })
    }
    return { exposed: true, focused: document.hasFocus(), panes }
  })
}

async function installOpenUrlStub(electronApp) {
  return electronApp.evaluate(({ BrowserWindow, shell }, shouldChurnFocus) => {
    const original = shell.openExternal
    globalThis.__terminalGarbleStubbedUrls ??= []
    shell.openExternal = async (url) => {
      globalThis.__terminalGarbleStubbedUrls.push({ url, at: Date.now() })
      if (shouldChurnFocus) {
        globalThis.__terminalGarbleFocusSink?.destroy()
        const sink = new BrowserWindow({
          width: 160,
          height: 100,
          x: -10_000,
          y: -10_000,
          show: false
        })
        globalThis.__terminalGarbleFocusSink = sink
        await sink.loadURL('data:text/html,<title>focus-sink</title>')
        sink.show()
        sink.focus()
      }
    }
    return { installed: shell.openExternal !== original }
  }, focusChurn)
}

async function releaseFocusSink(electronApp) {
  return electronApp.evaluate(() => {
    const sink = globalThis.__terminalGarbleFocusSink
    const existed = Boolean(sink && !sink.isDestroyed())
    sink?.destroy()
    globalThis.__terminalGarbleFocusSink = null
    return existed
  })
}

async function installOpenUrlRecorder(electronApp) {
  return electronApp.evaluate(({ shell }) => {
    const original = shell.openExternal.bind(shell)
    globalThis.__terminalGarbleOpenedUrls = []
    shell.openExternal = async (url, options) => {
      globalThis.__terminalGarbleOpenedUrls.push({ url, at: Date.now() })
      return original(url, options)
    }
  })
}

async function readOpenUrlCalls(electronApp) {
  return electronApp.evaluate(() => ({
    opened: globalThis.__terminalGarbleOpenedUrls ?? [],
    stubbed: globalThis.__terminalGarbleStubbedUrls ?? []
  }))
}

async function clickUrlAndCapture(electronApp, page, geometry, viewport, attempt) {
  const targetPane = geometry[attempt % geometry.length]
  const { bounds, cell } = targetPane
  const target = {
    x: bounds.x + cell.width * 12,
    y: bounds.y + cell.height * 0.5
  }
  const attemptDir = path.join(evidenceDir, `attempt-${attempt + 1}`)
  mkdirSync(attemptDir, { recursive: true })

  await page.waitForFunction(
    ({ paneIndex, url }) => {
      const visible = (window.__terminalGarbleTerminals ?? []).filter(
        (terminal) => terminal.element?.offsetWidth && terminal.element?.offsetHeight
      )
      const terminal = visible[paneIndex]
      const line = terminal?.buffer?.active?.getLine(terminal.buffer.active.viewportY)
      return line?.translateToString(true).startsWith(url) === true
    },
    { paneIndex: targetPane.index, url: URL },
    { timeout: 10_000 }
  )

  const beforeState = await terminalState(page)
  const before = await page.screenshot()
  const baselinePanes = analyzeTerminalFrame(before, geometry, viewport, beforeState)
  writeFileSync(path.join(attemptDir, 'before.png'), before)
  writeFileSync(
    path.join(attemptDir, 'state-before.json'),
    `${JSON.stringify(beforeState, null, 2)}\n`
  )
  const initialCalls = await readOpenUrlCalls(electronApp)
  const initialCallCount = initialCalls.opened.length + initialCalls.stubbed.length
  let hoverState = null
  let activationAttempts = 0
  let activated = false
  while (!activated && activationAttempts < 3) {
    activationAttempts++
    await page.waitForFunction(
      ({ paneIndex, url }) => {
        const visible = (window.__terminalGarbleTerminals ?? []).filter(
          (terminal) => terminal.element?.offsetWidth && terminal.element?.offsetHeight
        )
        const terminal = visible[paneIndex]
        const line = terminal?.buffer?.active?.getLine(terminal.buffer.active.viewportY)
        return line?.translateToString(true).startsWith(url) === true
      },
      { paneIndex: targetPane.index, url: URL },
      { timeout: 10_000 }
    )
    await page.mouse.move(target.x, target.y)
    await page
      .waitForFunction(
        ({ x, y }) =>
          document
            .elementsFromPoint(x, y)
            .some((element) => element.classList?.contains('xterm-cursor-pointer')),
        target,
        { timeout: 800 }
      )
      .catch(() => false)
    hoverState = await page.evaluate(({ x, y }) => {
      const elements = document.elementsFromPoint(x, y).map((element) => ({
        tag: element.tagName,
        className: String(element.className),
        title: element.getAttribute('title')
      }))
      return {
        elements,
        decorations: document.querySelectorAll('.xterm-decoration').length
      }
    }, target)
    await page.keyboard.down(MODIFIER)
    await page.mouse.click(target.x, target.y)
    await page.keyboard.up(MODIFIER)
    await page.waitForTimeout(300)
    const calls = await readOpenUrlCalls(electronApp)
    activated = calls.opened.length + calls.stubbed.length > initialCallCount
  }
  if (!activated) {
    throw new Error(`OSC-8 URL did not activate after ${activationAttempts} verified gestures`)
  }
  await page.waitForTimeout(250)
  const focusTransition = {
    rendererFocused: await page.evaluate(() => document.hasFocus()),
    ...(await electronApp.evaluate(({ BrowserWindow }) => {
      const sink = globalThis.__terminalGarbleFocusSink
      const focusedWindow = BrowserWindow.getFocusedWindow()
      return {
        sinkFocused: Boolean(sink && !sink.isDestroyed() && sink.isFocused()),
        focusedWindowIsSink: Boolean(sink && focusedWindow === sink)
      }
    }))
  }
  const focusSinkReleased = await releaseFocusSink(electronApp)
  await page.bringToFront()
  await page.waitForTimeout(500)

  const frames = []
  const deadline = Date.now() + CAPTURE_WINDOW_MS
  let frame = 0
  while (Date.now() < deadline) {
    const png = await page.screenshot()
    const state = await terminalState(page)
    const file = `frame-${String(frame).padStart(3, '0')}.png`
    writeFileSync(path.join(attemptDir, file), png)
    frames.push({
      file,
      at: Date.now(),
      panes: analyzeTerminalFrame(png, geometry, viewport, state)
    })
    frame++
    await page.waitForTimeout(CAPTURE_INTERVAL_MS)
  }
  writeFileSync(
    path.join(attemptDir, 'state-after.json'),
    `${JSON.stringify(await terminalState(page), null, 2)}\n`
  )
  writeFileSync(path.join(attemptDir, 'metrics.json'), `${JSON.stringify(frames, null, 2)}\n`)
  return {
    attempt: attempt + 1,
    targetPane: targetPane.index,
    activationAttempts,
    focusSinkReleased,
    hoverState,
    focusTransition,
    baselinePanes,
    frames
  }
}

sanitizeProfile()
let app
let page
let summary
try {
  const { ELECTRON_RUN_AS_NODE: _drop, ...cleanEnv } = process.env
  const launchTarget = mainPath ? { args: [path.resolve(mainPath)] } : { executablePath }
  app = await electron.launch({
    ...launchTarget,
    env: {
      ...cleanEnv,
      ORCA_E2E_USER_DATA_DIR: userDataDir,
      ...(mainPath ? { NODE_ENV: 'development', ORCA_E2E_HEADFUL: '1' } : {})
    }
  })
  page = await app.firstWindow({ timeout: 120_000 })
  await page.waitForLoadState('domcontentloaded')
  await page.keyboard.press('Escape')
  await configurePanes(page)
  const recoveredTerminals = await exposeProductionTerminals(page)
  const geometry = await paneGeometry(page)
  const oracleState = await terminalState(page)
  const viewport = await page.evaluate(() => ({
    width: document.documentElement.clientWidth,
    height: document.documentElement.clientHeight
  }))
  if (geometry.length < PANE_COUNT) {
    throw new Error(`Expected ${PANE_COUNT} visible panes, found ${geometry.length}`)
  }
  if (oracleState.panes.length < geometry.length) {
    throw new Error(
      `Terminal buffer recovery found ${oracleState.panes.length} panes for ${geometry.length} captured panes`
    )
  }
  writeFileSync(path.join(evidenceDir, 'geometry.json'), `${JSON.stringify(geometry, null, 2)}\n`)

  await installOpenUrlRecorder(app)
  const attempts = []
  let openUrlStub = stubOpenUrl ? await installOpenUrlStub(app) : null
  for (let attempt = 0; attempt < CLICK_COUNT; attempt++) {
    attempts.push(await clickUrlAndCapture(app, page, geometry, viewport, attempt))
    if (attempt === 0 && stubOpenUrlAfterFirst) {
      openUrlStub = await installOpenUrlStub(app)
      if (!openUrlStub.installed && CLICK_COUNT > 1) {
        throw new Error(`Could not stub openUrl after the verified click: ${openUrlStub.reason}`)
      }
    }
  }
  const suspects = findPersistentCellDivergences(attempts)
  const openUrlCalls = await readOpenUrlCalls(app)
  summary = {
    executablePath: mainPath ? path.resolve(mainPath) : executablePath,
    runRoot,
    viewport,
    geometry,
    recoveredTerminals,
    focusChurn,
    glyphChurn,
    openUrlStub,
    openUrlCalls,
    attempts: attempts.map((attempt) => ({
      attempt: attempt.attempt,
      targetPane: attempt.targetPane,
      activationAttempts: attempt.activationAttempts,
      focusSinkReleased: attempt.focusSinkReleased,
      hoverState: attempt.hoverState,
      focusTransition: attempt.focusTransition,
      frameCount: attempt.frames.length
    })),
    suspects
  }
  writeFileSync(path.join(evidenceDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`)
  console.log(JSON.stringify(summary, null, 2))
} catch (error) {
  if (page) {
    await page.screenshot({ path: path.join(evidenceDir, 'failure.png') }).catch(() => {})
    const diagnostic = await page
      .evaluate(() => ({
        title: document.title,
        url: location.href,
        text: document.body?.innerText.slice(0, 10_000) ?? '',
        buttons: Array.from(document.querySelectorAll('button,[role="button"]'))
          .map((element) => element.getAttribute('aria-label') || element.textContent?.trim())
          .filter(Boolean)
      }))
      .catch(() => null)
    writeFileSync(
      path.join(evidenceDir, 'failure.json'),
      `${JSON.stringify({ error: String(error), diagnostic }, null, 2)}\n`
    )
  }
  throw error
} finally {
  await app?.close().catch(() => {})
  if (!keepProfile) {
    rmSync(userDataDir, { recursive: true, force: true })
  }
  console.error(`[terminal-garble] evidence: ${evidenceDir}`)
}
