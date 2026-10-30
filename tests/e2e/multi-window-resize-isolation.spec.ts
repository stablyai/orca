import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { quotePosixShell } from '../../src/shared/shell-argument-quoting'
import { toWebTerminalSurfaceTabId } from '../../src/shared/terminal-surface-id'
import { expect, test } from './helpers/orca-app'
import { focusActiveTerminalInput, waitForActivePanePtyId } from './helpers/terminal'
import { createTerminalTabFromMenu } from './helpers/terminal-tab-menu'
import { worktreeRowSurface } from './worktree-row-locators'

test.skip(process.platform !== 'linux', 'The process geometry fixture uses a local POSIX shell')
test.skip(process.env.ORCA_E2E_WEB_CLIENT !== '1', 'Requires the bundled connected-client UI')
test.use({ orcaAppExtraArgs: ['--ozone-platform=x11'], minimumSeededWorktreeCount: 2 })

type Grid = { cols: number; rows: number }

function createTuiFixture(scratch: string, marker: string) {
  const script = path.join(scratch, 'geometry-tui.mjs')
  const log = path.join(scratch, `${marker}.log`)
  writeFileSync(
    script,
    String.raw`import { appendFileSync } from 'node:fs'
const log = process.argv[2]
const marker = process.argv[3]
let accepted = ''
let pending = ''
let escaping = false
const record = (text) => appendFileSync(log, text + '\n')
const size = () => process.stdout.columns + 'x' + process.stdout.rows
const draw = () => {
  const cols = process.stdout.columns
  const rows = process.stdout.rows
  process.stdout.write('\u001b[2J\u001b[H' + marker +
    '\u001b[2;1HSIZE:' + size() + '\u001b[3;1HINPUT:' + accepted +
    '\u001b[4;' + (cols - 9) + 'HRIGHT_EDGE' +
    '\u001b[' + rows + ';1HBOTTOM_EDGE\u001b[6;9H')
}
record('PID:' + process.pid)
record('SIZE:' + size())
process.stdout.write('\u001b[?1049h')
draw()
process.stdout.on('resize', () => {
  record('RESIZE:' + size())
  record('SIZE:' + size())
  draw()
})
process.stdin.setRawMode(true)
process.stdin.setEncoding('utf8')
process.stdin.on('data', (data) => {
  for (const char of data) {
    if (char === '\u001b') {
      escaping = true
      continue
    }
    if (escaping) {
      if (char !== '[' && char >= '@' && char <= '~') escaping = false
      continue
    }
    if (char === '\u0003') {
      process.stdout.write('\u001b[?1049l')
      process.exit(0)
    }
    if (char === '\r' || char === '\n') {
      if (pending) {
        accepted = pending
        pending = ''
        record('INPUT:' + accepted)
        record('SIZE:' + size())
        draw()
      }
    } else if (char >= ' ' && char <= '~') {
      pending += char
    }
  }
})
process.stdin.resume()
`
  )
  return {
    marker,
    command: [process.execPath, script, log, marker].map(quotePosixShell).join(' '),
    read() {
      const text = existsSync(log) ? readFileSync(log, 'utf8') : ''
      const sizes = Array.from(text.matchAll(/^SIZE:(\d+)x(\d+)$/gm))
      const latest = sizes.at(-1)
      return {
        pid: Number(/^PID:(\d+)$/m.exec(text)?.[1] ?? 0),
        cols: Number(latest?.[1] ?? 0),
        rows: Number(latest?.[2] ?? 0),
        resizeEvents: text.split('\n').filter((line) => line.startsWith('RESIZE:')),
        inputs: text.split('\n').filter((line) => line.startsWith('INPUT:'))
      }
    }
  }
}

type TuiFixture = ReturnType<typeof createTuiFixture>

async function readGrid(page: Page) {
  return page.evaluate(() => {
    const state = window.__store?.getState()
    const worktree = state?.activeWorktreeId
    const tab = worktree ? state?.activeTabIdByWorktree[worktree] : null
    const pane = tab ? window.__paneManagers?.get(tab)?.getActivePane() : null
    const viewport = pane?.container.querySelector<HTMLElement>('.xterm-container')
    const screen = pane?.container.querySelector<HTMLElement>('.xterm-screen')
    if (!worktree || !tab || !pane || !viewport || !screen) {
      throw new Error('Active terminal geometry is unavailable')
    }
    const buffer = pane.terminal.buffer.active
    return {
      worktree,
      tab,
      pty: pane.container.dataset.ptyId,
      cols: pane.terminal.cols,
      rows: pane.terminal.rows,
      viewportWidth: viewport.clientWidth,
      viewportHeight: viewport.clientHeight,
      screenWidth: screen.getBoundingClientRect().width,
      screenHeight: screen.getBoundingClientRect().height,
      scrollWidth: viewport.scrollWidth,
      scrollHeight: viewport.scrollHeight,
      bufferType: buffer.type,
      cursorX: buffer.cursorX,
      cursorY: buffer.cursorY,
      firstLine: buffer.getLine(0)?.translateToString(true),
      acceptedLine: buffer.getLine(2)?.translateToString(true),
      rightEdge: buffer.getLine(3)?.translateToString(true),
      bottomEdge: buffer.getLine(pane.terminal.rows - 1)?.translateToString(true)
    }
  })
}

// Exercise real sharing/resize code while all native windows remain physically hidden.
async function emulateVisibleHiddenWindow(app: ElectronApplication, page: Page): Promise<void> {
  const window = await app.browserWindow(page)
  const wasVisible = await window.evaluate((window) => {
    const wasVisible = window.isVisible()
    window.webContents.setBackgroundThrottling(false)
    window.isVisible = () => true
    window.isMinimized = () => false
    window.emit('show')
    return wasVisible
  })
  expect(wasVisible, 'Native test windows must remain hidden on the desktop').toBe(false)
}

async function resizeWindow(app: ElectronApplication, page: Page, width: number, height: number) {
  const window = await app.browserWindow(page)
  await window.evaluate((window, size) => window.setSize(size.width, size.height), {
    width,
    height
  })
}

async function openWorker(app: ElectronApplication): Promise<Page> {
  const opened = app.waitForEvent('window')
  await app.evaluate(({ Menu }) => {
    const item = Menu.getApplicationMenu()?.getMenuItemById('new-window')
    if (!item) {
      throw new Error('New Window menu item is missing')
    }
    item.click()
  })
  const page = await opened
  await expect(page.locator('[data-worktree-sidebar]')).toBeVisible({ timeout: 30_000 })
  await emulateVisibleHiddenWindow(app, page)
  return page
}

async function selectWorktree(page: Page, worktree: string): Promise<void> {
  const row = worktreeRowSurface(page, worktree)
  await expect(row).toBeVisible()
  await row.click()
  await expect(page.locator('[data-rendered-active-worktree-id]')).toHaveAttribute(
    'data-rendered-active-worktree-id',
    worktree
  )
  await waitForActivePanePtyId(page, 30_000)
}

async function typeToken(page: Page, fixture: TuiFixture, token: string): Promise<void> {
  await focusActiveTerminalInput(page)
  await page.keyboard.type(token)
  await page.keyboard.press('Enter')
  await expect.poll(() => fixture.read().inputs).toContain(`INPUT:${token}`)
  await expect.poll(async () => (await readGrid(page)).acceptedLine).toBe(`INPUT:${token}`)
}

async function startTui(page: Page, fixture: TuiFixture): Promise<void> {
  await waitForActivePanePtyId(page, 30_000)
  await focusActiveTerminalInput(page)
  await page.keyboard.type(fixture.command)
  await page.keyboard.press('Enter')
  await expect.poll(() => fixture.read().pid, { timeout: 30_000 }).toBeGreaterThan(0)
  await expect.poll(async () => (await readGrid(page)).firstLine).toBe(fixture.marker)
  await expect
    .poll(async () => {
      const grid = await readGrid(page)
      const reported = fixture.read()
      return { cols: grid.cols - reported.cols, rows: grid.rows - reported.rows }
    })
    .toEqual({ cols: 0, rows: 0 })
}

async function expectCanonicalFrame(
  page: Page,
  fixture: TuiFixture,
  canonical: Grid
): Promise<void> {
  await expect
    .poll(async () => {
      const grid = await readGrid(page)
      return {
        cols: grid.cols,
        rows: grid.rows,
        buffer: grid.bufferType,
        firstLine: grid.firstLine,
        rightEdge: grid.rightEdge?.endsWith('RIGHT_EDGE'),
        bottomEdge: grid.bottomEdge,
        cursor: [grid.cursorX, grid.cursorY]
      }
    })
    .toEqual({
      ...canonical,
      buffer: 'alternate',
      firstLine: fixture.marker,
      rightEdge: true,
      bottomEdge: 'BOTTOM_EDGE',
      cursor: [8, 5]
    })
  expect(fixture.read()).toMatchObject(canonical)
}

test('pins a mirrored PTY through resize and focus, then releases it on navigation and close', async ({
  orcaPage,
  electronApp,
  registerPostElectronShutdownCleanup
}, testInfo) => {
  // Real PTY redraws and four workspace/owner handoffs need time on shared CI runners.
  test.setTimeout(180_000)
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'orca-multi-window-grid-'))
  registerPostElectronShutdownCleanup(async () => rmSync(scratch, { recursive: true, force: true }))
  const shared = createTuiFixture(scratch, 'SHARED_PTY')
  const independent = createTuiFixture(scratch, 'INDEPENDENT_PTY')
  const hostFocus = await orcaPage.context().newCDPSession(orcaPage)
  await hostFocus.send('Emulation.setFocusEmulationEnabled', { enabled: true })
  await emulateVisibleHiddenWindow(electronApp, orcaPage)
  await resizeWindow(electronApp, orcaPage, 1440, 960)
  const worktrees = await orcaPage.evaluate(() =>
    window.__store
      ?.getState()
      .allWorktrees()
      .map((w) => w.id)
  )
  if (!worktrees || worktrees.length < 2) {
    throw new Error('Two seeded workspaces are required')
  }
  await selectWorktree(orcaPage, worktrees[0])
  await startTui(orcaPage, shared)
  const original = await readGrid(orcaPage)
  const canonical = { cols: original.cols, rows: original.rows }
  const originalProcess = shared.read()
  await expectCanonicalFrame(orcaPage, shared, canonical)
  await orcaPage.evaluate(() => window.api.settings.set({ experimentalMultiWindow: true }))
  const worker = await openWorker(electronApp)
  const workerFocus = await worker.context().newCDPSession(worker)
  try {
    await workerFocus.send('Emulation.setFocusEmulationEnabled', { enabled: true })
    await selectWorktree(worker, worktrees[0])
    expect((await readGrid(worker)).tab).toBe(toWebTerminalSurfaceTabId(original.tab))
    await expectCanonicalFrame(worker, shared, canonical)
    expect(shared.read().resizeEvents).toEqual(originalProcess.resizeEvents)
    await typeToken(worker, shared, 'SECOND_WINDOW_READY')

    const wideWorker = await readGrid(worker)
    await resizeWindow(electronApp, worker, 700, 480)
    await expect
      .poll(async () => (await readGrid(worker)).viewportWidth)
      .toBeLessThan(wideWorker.viewportWidth - 100)
    await typeToken(worker, shared, 'WORKER_COMPACT')
    await expectCanonicalFrame(orcaPage, shared, canonical)
    await expectCanonicalFrame(worker, shared, canonical)
    await expect
      .poll(async () => {
        const grid = await readGrid(worker)
        return {
          horizontal: grid.scrollWidth > grid.viewportWidth,
          vertical: grid.scrollHeight > grid.viewportHeight
        }
      })
      .toEqual({ horizontal: true, vertical: true })
    const scrolled = await worker.evaluate(() => {
      const state = window.__store?.getState()
      const tab = state?.activeWorktreeId
        ? state.activeTabIdByWorktree[state.activeWorktreeId]
        : null
      const pane = tab ? window.__paneManagers?.get(tab)?.getActivePane() : null
      const viewport = pane?.container.querySelector<HTMLElement>('.xterm-container')
      const screen = pane?.container.querySelector<HTMLElement>('.xterm-screen')
      if (!viewport || !screen) {
        throw new Error('Terminal scroll viewport is unavailable')
      }
      viewport.scrollLeft = viewport.scrollWidth
      viewport.scrollTop = viewport.scrollHeight
      const viewportBox = viewport.getBoundingClientRect()
      const screenBox = screen.getBoundingClientRect()
      return {
        left: viewport.scrollLeft,
        top: viewport.scrollTop,
        rightEdgeReachable:
          screenBox.right <= viewportBox.right + 1 && screenBox.right > viewportBox.left,
        bottomEdgeReachable:
          screenBox.bottom <= viewportBox.bottom + 1 && screenBox.bottom > viewportBox.top
      }
    })
    expect(scrolled.left).toBeGreaterThan(0)
    expect(scrolled.top).toBeGreaterThan(0)
    expect(scrolled.rightEdgeReachable).toBe(true)
    expect(scrolled.bottomEdgeReachable).toBe(true)
    if (process.env.ORCA_E2E_CAPTURE_VISUALS === '1') {
      for (const theme of ['light', 'dark'] as const) {
        await worker.locator('[data-local-shared-grid="true"]').evaluate((viewport) => {
          viewport.scrollTop = 0
          viewport.scrollLeft = viewport.scrollWidth
        })
        await worker.evaluate(
          (theme) => window.__store?.getState().updateSettingsOrThrow({ theme }),
          theme
        )
        await expect(worker.locator('html')).toHaveClass(
          theme === 'dark' ? /dark/ : /^(?!.*dark).*$/
        )
        const screenshot = await workerFocus.send('Page.captureScreenshot', { format: 'png' })
        await testInfo.attach(`shared-terminal-scroll-${theme}`, {
          body: Buffer.from(screenshot.data, 'base64'),
          contentType: 'image/png'
        })
      }
    }
    await typeToken(orcaPage, shared, 'HOST_STILL_INTERACTIVE')
    await resizeWindow(electronApp, orcaPage, 1800, 1100)
    await typeToken(worker, shared, 'SHARED_RESIZE_SETTLED')
    await expectCanonicalFrame(orcaPage, shared, canonical)
    await expectCanonicalFrame(worker, shared, canonical)
    expect(shared.read()).toMatchObject({
      pid: originalProcess.pid,
      resizeEvents: originalProcess.resizeEvents
    })

    // Restore a wide sidebar before selecting another workspace; compact rows are hidden.
    await resizeWindow(electronApp, worker, 1440, 960)
    await selectWorktree(worker, worktrees[1])
    await startTui(worker, independent)
    expect(independent.read().pid).not.toBe(originalProcess.pid)
    await expect.poll(async () => (await readGrid(orcaPage)).cols).toBeGreaterThan(canonical.cols)
    const hostAfterNavigation = await readGrid(orcaPage)
    await testInfo.attach('navigation-grid-observation', {
      body: JSON.stringify(
        { host: hostAfterNavigation, shared: shared.read(), worker: await readGrid(worker) },
        null,
        2
      ),
      contentType: 'application/json'
    })
    await expectCanonicalFrame(orcaPage, shared, {
      cols: hostAfterNavigation.cols,
      rows: hostAfterNavigation.rows
    })
    const independentBefore = await readGrid(worker)
    const hostBeforeIndependentResize = await readGrid(orcaPage)
    const sharedBeforeIndependentResize = shared.read()
    await resizeWindow(electronApp, worker, 1800, 1050)
    await expect
      .poll(async () => (await readGrid(worker)).cols)
      .toBeGreaterThan(independentBefore.cols)
    await typeToken(worker, independent, 'INDEPENDENT_RESIZED')
    expect(await readGrid(orcaPage)).toEqual(hostBeforeIndependentResize)
    expect(shared.read()).toEqual(sharedBeforeIndependentResize)
    expect(independent.read().cols).toBe((await readGrid(worker)).cols)

    // The host is the sole visible viewer of its PTY after navigation away.
    await resizeWindow(electronApp, orcaPage, 1200, 800)
    await expect.poll(async () => (await readGrid(orcaPage)).cols).not.toBe(canonical.cols)
    await typeToken(orcaPage, shared, 'NAVIGATION_RELEASED')
    const released = await readGrid(orcaPage)
    expect(shared.read()).toMatchObject({ cols: released.cols, rows: released.rows })
    await selectWorktree(worker, worktrees[0])
    await expectCanonicalFrame(worker, shared, { cols: released.cols, rows: released.rows })
    await selectWorktree(orcaPage, worktrees[1])
    await expect.poll(async () => (await readGrid(worker)).cols).toBeGreaterThan(released.cols)
    await typeToken(worker, shared, 'WORKER_SOLE_VIEW')
    const workerOwned = await readGrid(worker)
    await expectCanonicalFrame(worker, shared, { cols: workerOwned.cols, rows: workerOwned.rows })
    await selectWorktree(orcaPage, worktrees[0])
    await expectCanonicalFrame(orcaPage, shared, { cols: workerOwned.cols, rows: workerOwned.rows })
    await workerFocus.detach()
    await worker.close()
    await resizeWindow(electronApp, orcaPage, 1800, 1000)
    await expect.poll(async () => (await readGrid(orcaPage)).cols).toBeGreaterThan(released.cols)
    await typeToken(orcaPage, shared, 'CLOSE_RELEASED')
    const final = await readGrid(orcaPage)
    await expect
      .poll(() => shared.read())
      .toMatchObject({
        pid: originalProcess.pid,
        cols: final.cols,
        rows: final.rows
      })
    await expectCanonicalFrame(orcaPage, shared, { cols: final.cols, rows: final.rows })
    await testInfo.attach('terminal-grid-proof', {
      body: JSON.stringify(
        {
          nativeVisibility: 'simulated; native windows stayed hidden',
          canonical,
          originalProcess,
          final: shared.read(),
          independent: independent.read()
        },
        null,
        2
      ),
      contentType: 'application/json'
    })
  } finally {
    if (!worker.isClosed()) {
      await workerFocus.detach()
      await worker.close()
    }
    await hostFocus.detach()
  }
})

test('different terminal tabs in one workspace retain independent PTY grids', async ({
  orcaPage,
  electronApp,
  registerPostElectronShutdownCleanup
}) => {
  // Two real PTY launches and paired-tab hydration must complete on shared CI runners.
  test.setTimeout(120_000)
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'orca-multi-window-tab-grid-'))
  registerPostElectronShutdownCleanup(async () => rmSync(scratch, { recursive: true, force: true }))
  const hostTui = createTuiFixture(scratch, 'HOST_TAB_PTY')
  const workerTui = createTuiFixture(scratch, 'WORKER_TAB_PTY')
  const hostFocus = await orcaPage.context().newCDPSession(orcaPage)
  await hostFocus.send('Emulation.setFocusEmulationEnabled', { enabled: true })
  await emulateVisibleHiddenWindow(electronApp, orcaPage)
  const firstWorktree = await orcaPage.evaluate(
    () => window.__store?.getState().allWorktrees()[0]?.id
  )
  if (!firstWorktree) {
    throw new Error('A seeded workspace is required')
  }
  await selectWorktree(orcaPage, firstWorktree)
  await startTui(orcaPage, hostTui)
  const hostBefore = await readGrid(orcaPage)
  await orcaPage.evaluate(() => window.api.settings.set({ experimentalMultiWindow: true }))
  const worker = await openWorker(electronApp)
  const workerFocus = await worker.context().newCDPSession(worker)
  try {
    await workerFocus.send('Emulation.setFocusEmulationEnabled', { enabled: true })
    await selectWorktree(worker, hostBefore.worktree)
    const newTab = await createTerminalTabFromMenu(worker)
    expect(newTab).not.toBe(toWebTerminalSurfaceTabId(hostBefore.tab))
    await waitForActivePanePtyId(worker, 30_000)
    await startTui(worker, workerTui)
    expect(workerTui.read().pid).not.toBe(hostTui.read().pid)
    const before = await readGrid(worker)
    const hostProcess = hostTui.read()
    await resizeWindow(electronApp, worker, 1800, 1050)
    await expect.poll(async () => (await readGrid(worker)).cols).toBeGreaterThan(before.cols)
    await typeToken(worker, workerTui, 'NEW_TAB_RESIZED')
    expect(await readGrid(orcaPage)).toEqual(hostBefore)
    expect(hostTui.read()).toEqual(hostProcess)
    const resized = await readGrid(worker)
    expect(workerTui.read()).toMatchObject({ cols: resized.cols, rows: resized.rows })
  } finally {
    await workerFocus.detach()
    await worker.close()
    await hostFocus.detach()
  }
})
