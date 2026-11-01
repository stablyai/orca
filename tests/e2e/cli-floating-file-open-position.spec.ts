import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { runProcess } from '@orca/process-host'
import { expect, test } from './helpers/orca-app'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { startHiddenRendererFrameCapture } from './helpers/hidden-renderer-frame-capture'

const FLOATING = 'global-floating-terminal'
const PANEL = '[data-floating-terminal-panel][aria-hidden="false"]'

test('CLI positions floating files without changing the main workspace or reclaiming its input', async ({
  electronApp,
  orcaPage
}, testInfo) => {
  await waitForSessionReady(orcaPage)
  const mainWorktreeId = await waitForActiveWorktree(orcaPage)
  const mainRoot = await orcaPage.evaluate(
    (id) =>
      Object.values(window.__store?.getState().worktreesByRepo ?? {})
        .flat()
        .find((worktree) => worktree.id === id)?.path,
    mainWorktreeId
  )
  if (!mainRoot) {
    throw new Error('Main workspace path unavailable')
  }
  const roots = { main: mainRoot, floating: path.join(mainRoot, 'floating-position-fixture') }
  mkdirSync(roots.floating, { recursive: true })
  await electronApp.evaluate(({ dialog }, floatingPath) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [floatingPath],
      bookmarks: []
    })
  }, roots.floating)
  await orcaPage.evaluate(async (floatingPath) => {
    const store = window.__store
    if (!store) {
      throw new Error('Store unavailable')
    }
    const pickedPath = await window.api.app.pickFloatingWorkspaceDirectory()
    if (pickedPath !== floatingPath) {
      throw new Error('Floating directory fixture was not granted')
    }
    await store.getState().updateSettings({
      floatingTerminalEnabled: true,
      floatingTerminalCwd: floatingPath
    })
    store.setState({ floatingWorkspacePanelOpen: false })
  }, roots.floating)
  const userDataDir = await electronApp.evaluate(({ app }) => app.getPath('userData'))
  const relativePath = 'floating-position-proof.ts'
  const emptyPath = 'floating-empty-position-proof.txt'
  const mainFile = path.join(roots.main, relativePath)
  const floatingFile = path.join(roots.floating, relativePath)
  const floatingEmpty = path.join(roots.floating, emptyPath)
  const lines = Array.from({ length: 400 }, (_, index) => `const line${index + 1} = ${index + 1}`)
  mkdirSync(roots.floating, { recursive: true })
  writeFileSync(mainFile, 'const main = 1\n')
  writeFileSync(floatingFile, lines.join('\n'))
  writeFileSync(floatingEmpty, '')
  const open = async (worktree: string, file: string, flags: string[]): Promise<void> => {
    const result = await runProcess({
      program: process.execPath,
      args: [
        path.join(process.cwd(), 'out', 'cli', 'index.js'),
        'file',
        'open',
        file,
        '--worktree',
        `id:${worktree}`,
        '--json',
        ...flags
      ],
      env: { ...process.env, ORCA_USER_DATA_PATH: userDataDir },
      timeoutMs: 30_000
    })
    expect(result.code, `${result.stderr}\n${result.stdout}`).toBe(0)
  }
  const pendingPosition = () =>
    orcaPage.evaluate(() => {
      const reveal = window.__store?.getState().pendingEditorReveal
      return reveal && { line: reveal.line, column: reveal.column, eligible: reveal.canApply?.() }
    })
  const oversizedPosition = {
    line: Number.MAX_SAFE_INTEGER,
    column: Number.MAX_SAFE_INTEGER,
    eligible: true
  }
  const resumeHiddenRendererFrames = async (): Promise<void> => {
    const browserWindow = await electronApp.browserWindow(orcaPage)
    // Linux throttles hidden renderers to one frame per second, beyond this reveal's frame budget.
    const state = await browserWindow.evaluate((window) => {
      window.webContents.setBackgroundThrottling(false)
      return {
        throttled: window.webContents.getBackgroundThrottling(),
        visible: window.isVisible(),
        focused: window.isFocused()
      }
    })
    await browserWindow.dispose()
    expect(state).toEqual({ throttled: false, visible: false, focused: false })
  }
  let stopFrameCapture: (() => Promise<void>) | undefined
  try {
    await open(mainWorktreeId, relativePath, ['--focus'])
    await expect(orcaPage.locator('.monaco-editor:visible')).toHaveCount(1)
    const mainProbe = await orcaPage.evaluateHandle(() => window.__monacoEditorE2E)
    const mainInput = orcaPage
      .locator('.monaco-editor:visible')
      .first()
      .getByRole('textbox', { name: 'Editor content' })
    await open(FLOATING, relativePath, ['--focus', '--line', '300', '--column', '7'])
    const panel = orcaPage.locator(PANEL)
    await expect(panel).toBeVisible()
    await expect(panel.locator('.monaco-editor:visible')).toHaveCount(1)
    const floatingProbe = await orcaPage.evaluateHandle(() => window.__monacoEditorE2E)
    const cursor = () =>
      floatingProbe.evaluate((probe) => {
        const selection = probe?.snapshot().selection
        return { line: selection?.positionLineNumber, column: selection?.positionColumn }
      })
    await expect.poll(cursor).toEqual({ line: 300, column: 7 })
    const floatingInput = panel.getByRole('textbox', { name: 'Editor content' })
    expect(await orcaPage.evaluate(() => window.__store?.getState().activeWorktreeId)).toBe(
      mainWorktreeId
    )
    expect(
      await mainProbe.evaluate((probe) => probe?.snapshot().selection?.positionLineNumber)
    ).toBe(1)
    await open(FLOATING, emptyPath, ['--line', '1'])
    await expect(panel.locator('.editor-header-path')).toContainText(relativePath)
    expect(await cursor()).toEqual({ line: 300, column: 7 })
    await open(FLOATING, relativePath, ['--line', '17', '--column', '3'])
    await orcaPage.waitForTimeout(200)
    expect(await cursor()).toEqual({ line: 300, column: 7 })
    await mainInput.focus()
    await floatingInput.focus()
    await expect.poll(cursor).toEqual({ line: 17, column: 3 })

    // An oversized line keeps the existing content-wait loop active while the user changes input.
    await open(FLOATING, relativePath, [
      '--focus',
      '--line',
      String(Number.MAX_SAFE_INTEGER),
      '--column',
      String(Number.MAX_SAFE_INTEGER)
    ])
    await expect.poll(pendingPosition).toEqual(oversizedPosition)
    await mainInput.focus()
    expect(await pendingPosition()).toEqual({ ...oversizedPosition, eligible: false })
    await resumeHiddenRendererFrames()
    stopFrameCapture = await startHiddenRendererFrameCapture(orcaPage)
    await orcaPage.waitForTimeout(3500)
    expect(await cursor()).toEqual({ line: 17, column: 3 })
    await expect(mainInput).toBeFocused()
    await floatingInput.focus()
    await expect
      .poll(cursor, { timeout: 8000 })
      .toEqual({ line: 400, column: lines[399].length + 1 })
    const proofDir = path.join(process.cwd(), 'validation-screenshots', 'file-position-floating')
    mkdirSync(proofDir, { recursive: true })
    await testInfo.attach('floating-position-clamped.png', {
      body: await orcaPage.screenshot({ path: path.join(proofDir, 'clamped.png') }),
      contentType: 'image/png'
    })
    await open(FLOATING, emptyPath, [
      '--focus',
      '--line',
      String(Number.MAX_SAFE_INTEGER),
      '--column',
      String(Number.MAX_SAFE_INTEGER)
    ])
    await expect.poll(pendingPosition).toEqual(oversizedPosition)
    await resumeHiddenRendererFrames()
    await expect
      .poll(
        () =>
          orcaPage.evaluate(() => {
            const selection = window.__monacoEditorE2E?.snapshot().selection
            return { line: selection?.positionLineNumber, column: selection?.positionColumn }
          }),
        { timeout: 8000 }
      )
      .toEqual({ line: 1, column: 1 })
    await expect
      .poll(() => orcaPage.evaluate(() => window.__store?.getState().pendingEditorReveal))
      .toBeNull()
    expect(await orcaPage.evaluate(() => window.__store?.getState().activeWorktreeId)).toBe(
      mainWorktreeId
    )
    expect(
      await electronApp.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().every((window) => !window.isVisible() && !window.isFocused())
      )
    ).toBe(true)
  } finally {
    try {
      await stopFrameCapture?.()
    } finally {
      for (const file of [mainFile, floatingFile, floatingEmpty]) {
        rmSync(file, { force: true })
      }
    }
  }
})
