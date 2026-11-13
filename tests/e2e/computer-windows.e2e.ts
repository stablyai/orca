import { readFile } from 'node:fs/promises'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import type {
  ComputerActionResult,
  ComputerListAppsResult,
  ComputerListWindowsResult,
  ComputerSnapshotResult
} from '../../src/shared/runtime-types'
import {
  ensureOrcaRuntimeLaunched,
  ensureNotepadLaunched,
  findRoleIndex,
  getNotepadAppSelector,
  killNotepad,
  parseJsonOutput,
  runOrcaCli,
  stopOrcaRuntime
} from './helpers/computer-driver'
import { editableRolePattern, focusNotepadDocument } from './helpers/notepad-document'
import {
  closeWindowFixture,
  countMagentaPixelRatio,
  launchHungWindowFixture,
  launchWindowFixture
} from './helpers/windows-form-fixture'

const isWindows = process.platform === 'win32'
const e2eOptIn = process.env.ORCA_COMPUTER_E2E === '1'
describe.skipIf(!isWindows || !e2eOptIn)('computer-use Windows e2e (Notepad)', () => {
  let notepadPath = ''

  async function saveNotepad() {
    await runOrcaCli([
      'computer',
      'hotkey',
      '--app',
      getNotepadAppSelector(),
      '--key',
      'CmdOrCtrl+S',
      '--restore-window',
      '--no-screenshot',
      '--json'
    ])
  }

  beforeAll(async () => {
    await ensureOrcaRuntimeLaunched()
    notepadPath = await ensureNotepadLaunched()
  })

  afterAll(async () => {
    await killNotepad()
    await stopOrcaRuntime()
  })

  test('hotkey and Unicode paste-text replace the document selection', async () => {
    const app = getNotepadAppSelector()
    const first = `orca-windows-first-${Date.now()}`
    await focusNotepadDocument(app)
    await runOrcaCli([
      'computer',
      'paste-text',
      '--app',
      app,
      '--text',
      first,
      '--restore-window',
      '--no-screenshot',
      '--json'
    ])

    await runOrcaCli([
      'computer',
      'hotkey',
      '--app',
      app,
      '--key',
      'CmdOrCtrl+A',
      '--restore-window',
      '--no-screenshot',
      '--json'
    ])

    const marker = `orca-windows-replaced-café Ω 漢字 ${Date.now()}`
    await runOrcaCli([
      'computer',
      'paste-text',
      '--app',
      app,
      '--text',
      marker,
      '--restore-window',
      '--no-screenshot',
      '--json'
    ])
    await saveNotepad()
    await expect.poll(() => readFile(notepadPath, 'utf8')).toBe(marker)
  })

  test('click and type-text send synthetic input to the document', async () => {
    const app = getNotepadAppSelector()
    const before = parseJsonOutput<{ result: ComputerSnapshotResult }>(
      (await runOrcaCli(['computer', 'get-app-state', '--app', app, '--no-screenshot', '--json']))
        .stdout
    )
    const documentIndex = findRoleIndex(before.result.snapshot.treeText, editableRolePattern)
    expect(documentIndex).toBeGreaterThanOrEqual(0)

    await runOrcaCli([
      'computer',
      'click',
      '--app',
      app,
      '--element-index',
      String(documentIndex),
      '--restore-window',
      '--no-screenshot',
      '--json'
    ])

    const marker = ` typed-${Date.now()}`
    const typed = parseJsonOutput<{ result: ComputerActionResult }>(
      (
        await runOrcaCli([
          'computer',
          'type-text',
          '--app',
          app,
          '--text',
          marker,
          '--restore-window',
          '--no-screenshot',
          '--json'
        ])
      ).stdout
    )
    expect(typed.result.action?.path).toBe('synthetic')
    await saveNotepad()
    await expect.poll(() => readFile(notepadPath, 'utf8')).toContain(marker.trim())
  })

  test('a covered window screenshot shows the window, not what covers it', async () => {
    const app = getNotepadAppSelector()
    const notepadWindow = parseJsonOutput<{ result: ComputerListWindowsResult }>(
      (await runOrcaCli(['computer', 'list-windows', '--app', app, '--json'])).stdout
    ).result.windows[0]
    const bounds = {
      x: notepadWindow.x ?? 0,
      y: notepadWindow.y ?? 0,
      width: notepadWindow.width,
      height: notepadWindow.height
    }
    const cover = await launchWindowFixture(
      [
        "$form.Text = 'orca-e2e-cover'",
        "$form.FormBorderStyle = 'None'",
        "$form.StartPosition = 'Manual'",
        '$form.TopMost = $true',
        '$form.ShowInTaskbar = $false',
        '$form.BackColor = [System.Drawing.Color]::FromArgb(255, 0, 255)',
        `$form.Bounds = New-Object System.Drawing.Rectangle(${bounds.x}, ${bounds.y}, ${bounds.width}, ${bounds.height})`
      ].join('\n')
    )
    try {
      // Prove the cover really hides Notepad, so the screenshot check below can fail.
      expect(await countMagentaPixelRatio(bounds)).toBeGreaterThan(0.9)
      const state = parseJsonOutput<{ result: ComputerSnapshotResult }>(
        (await runOrcaCli(['computer', 'get-app-state', '--app', app, '--json'])).stdout
      )
      const screenshotPath = state.result.screenshot?.path
      if (!screenshotPath) {
        throw new Error(`no screenshot: ${JSON.stringify(state.result.screenshotStatus)}`)
      }
      // A screen copy of the covered bounds would be almost entirely the magenta cover.
      expect(await countMagentaPixelRatio(screenshotPath)).toBeLessThan(0.01)
    } finally {
      await closeWindowFixture(cover)
    }
  })

  test('a hung window reports a timeout error and later calls still succeed', async () => {
    const hung = await launchHungWindowFixture()
    try {
      const failure = await runOrcaCli([
        'computer',
        'get-app-state',
        '--app',
        `pid:${hung.pid}`,
        '--no-screenshot',
        '--json'
      ]).then(
        () => 'get-app-state unexpectedly succeeded',
        (error: unknown) => (error instanceof Error ? error.message : String(error))
      )
      expect(failure).toMatch(/window_not_responding/)
      expect(failure).toMatch(/"code":\s*"action_timeout"/)

      const apps = parseJsonOutput<{ result: ComputerListAppsResult }>(
        (await runOrcaCli(['computer', 'list-apps', '--json'])).stdout
      )
      expect(apps.result.apps.some((entry) => entry.pid === hung.pid)).toBe(true)
    } finally {
      await closeWindowFixture(hung)
    }
  })
})
