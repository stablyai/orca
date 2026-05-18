import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import type {
  ComputerActionResult,
  ComputerListAppsResult,
  ComputerListWindowsResult,
  ComputerSnapshotResult
} from '../../src/shared/runtime-types'
import {
  ensureNotepadLaunched,
  findRoleIndex,
  getNotepadAppSelector,
  killNotepad,
  parseJsonOutput,
  runOrcaCli
} from './helpers/computer-driver'

const isWindows = process.platform === 'win32'
const e2eOptIn = process.env.ORCA_COMPUTER_E2E === '1'

describe.skipIf(!isWindows || !e2eOptIn)('computer-use Windows e2e (Notepad)', () => {
  beforeAll(async () => {
    await ensureNotepadLaunched()
  })

  afterAll(async () => {
    await killNotepad()
  })

  test('list-apps includes the test-owned Notepad process', async () => {
    const result = await runOrcaCli(['computer', 'list-apps', '--json'])
    const envelope = parseJsonOutput<{ result: ComputerListAppsResult }>(result.stdout)
    const pid = Number.parseInt(getNotepadAppSelector().slice(4), 10)

    expect(envelope.result.apps).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'Notepad', pid })])
    )
  })

  test('list-windows returns a targetable Notepad window', async () => {
    const app = getNotepadAppSelector()
    const result = await runOrcaCli(['computer', 'list-windows', '--app', app, '--json'])
    const envelope = parseJsonOutput<{ result: ComputerListWindowsResult }>(result.stdout)

    expect(envelope.result.windows).toEqual([
      expect.objectContaining({
        index: 0,
        app: expect.objectContaining({ name: 'Notepad' }),
        id: expect.any(Number),
        title: expect.stringContaining('Notepad'),
        width: expect.any(Number),
        height: expect.any(Number)
      })
    ])
  })

  test('Notepad exposes a basic accessibility tree', async () => {
    const result = await runOrcaCli([
      'computer',
      'get-app-state',
      '--app',
      getNotepadAppSelector(),
      '--json'
    ])
    const envelope = parseJsonOutput<{ result: ComputerSnapshotResult }>(result.stdout)

    expect(envelope.result.snapshot.app.name).toBe('Notepad')
    expect(envelope.result.snapshot.window.title).toContain('Notepad')
    expect(envelope.result.snapshot.elementCount).toBeGreaterThan(0)
    expect(envelope.result.snapshot.coordinateSpace).toBe('window')
    expect(envelope.result.snapshot.truncation?.truncated).toBe(false)
    expect(envelope.result.screenshotStatus.state).toBe('captured')
    expect(envelope.result.screenshot?.format).toBe('png')
    expect(envelope.result.screenshot?.data).toBeUndefined()
    expect(envelope.result.screenshot?.dataOmitted).toBe(true)
    expect(envelope.result.screenshot?.path).toContain('orca-computer-use')
  })

  test('set-value mutates the document through UI Automation', async () => {
    const app = getNotepadAppSelector()
    const before = parseJsonOutput<{ result: ComputerSnapshotResult }>(
      (await runOrcaCli(['computer', 'get-app-state', '--app', app, '--no-screenshot', '--json']))
        .stdout
    )
    const documentIndex = findRoleIndex(before.result.snapshot.treeText, 'document')
    expect(documentIndex).toBeGreaterThanOrEqual(0)

    const marker = `orca-windows-set-${Date.now()}`
    const action = parseJsonOutput<{ result: ComputerActionResult }>(
      (
        await runOrcaCli([
          'computer',
          'set-value',
          '--app',
          app,
          '--element-index',
          String(documentIndex),
          '--value',
          marker,
          '--no-screenshot',
          '--json'
        ])
      ).stdout
    )
    expect(action.result.action?.path).toBe('accessibility')

    expect(action.result.snapshot.treeText).toContain(marker)
  })

  test('paste-text mutates the test-owned document', async () => {
    const app = getNotepadAppSelector()
    const marker = `orca-windows-paste-${Date.now()}`
    const action = parseJsonOutput<{ result: ComputerActionResult }>(
      (
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
      ).stdout
    )
    expect(action.result.action?.path).toBe('clipboard')

    const after = parseJsonOutput<{ result: ComputerSnapshotResult }>(
      (await runOrcaCli(['computer', 'get-app-state', '--app', app, '--no-screenshot', '--json']))
        .stdout
    )
    expect(after.result.snapshot.treeText).toContain(marker)
  })

  test('Unicode payloads survive set-value and paste-text', async () => {
    const app = getNotepadAppSelector()
    const before = parseJsonOutput<{ result: ComputerSnapshotResult }>(
      (await runOrcaCli(['computer', 'get-app-state', '--app', app, '--no-screenshot', '--json']))
        .stdout
    )
    const documentIndex = findRoleIndex(before.result.snapshot.treeText, 'document')
    expect(documentIndex).toBeGreaterThanOrEqual(0)

    const unicode = `orca unicode café Ω 漢字 ${Date.now()}`
    const set = parseJsonOutput<{ result: ComputerActionResult }>(
      (
        await runOrcaCli([
          'computer',
          'set-value',
          '--app',
          app,
          '--element-index',
          String(documentIndex),
          '--value',
          unicode,
          '--no-screenshot',
          '--json'
        ])
      ).stdout
    )
    expect(set.result.snapshot.treeText).toContain(unicode)

    const pasted = parseJsonOutput<{ result: ComputerActionResult }>(
      (
        await runOrcaCli([
          'computer',
          'paste-text',
          '--app',
          app,
          '--text',
          unicode,
          '--restore-window',
          '--no-screenshot',
          '--json'
        ])
      ).stdout
    )
    expect(pasted.result.snapshot.treeText).toContain(unicode)
  })

  test('hotkey and paste-text can replace the document selection', async () => {
    const app = getNotepadAppSelector()
    const first = `orca-windows-first-${Date.now()}`
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

    const selectAll = parseJsonOutput<{ result: ComputerActionResult }>(
      (
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
      ).stdout
    )
    expect(selectAll.result.action?.actionName).toBe('hotkey')

    const marker = `orca-windows-replaced-${Date.now()}`
    const second = parseJsonOutput<{ result: ComputerActionResult }>(
      (
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
      ).stdout
    )
    expect(second.result.snapshot.treeText).toContain(marker)
    expect(second.result.snapshot.treeText).not.toContain(first)
  })

  test('click and type-text send synthetic input to the document', async () => {
    const app = getNotepadAppSelector()
    const before = parseJsonOutput<{ result: ComputerSnapshotResult }>(
      (await runOrcaCli(['computer', 'get-app-state', '--app', app, '--no-screenshot', '--json']))
        .stdout
    )
    const documentIndex = findRoleIndex(before.result.snapshot.treeText, 'document')
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
    expect(typed.result.snapshot.treeText).toContain(marker.trim())
  })
})
