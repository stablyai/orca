import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import type {
  ComputerActionResult,
  ComputerListAppsResult,
  ComputerSnapshotResult
} from '../../src/shared/runtime-types'
import {
  activateFinder,
  ensureMCodeRuntimeLaunched,
  ensureTextEditLaunched,
  findRoleIndex,
  killTextEdit,
  parseJsonOutput,
  runMCodeCli
} from './helpers/computer-driver'
import {
  clickCapturedTextEditOpenDialog,
  doubleClickTextEditWord
} from './helpers/computer-coordinate-click-driver'

const isMac = process.platform === 'darwin'
const e2eOptIn = process.env.MCODE_COMPUTER_E2E === '1'

describe.skipIf(!isMac || !e2eOptIn)('computer-use macOS e2e (TextEdit)', () => {
  beforeAll(async () => {
    await ensureMCodeRuntimeLaunched()
    await ensureTextEditLaunched()
  })

  afterAll(async () => {
    await killTextEdit()
  })

  test('list-apps includes TextEdit', async () => {
    const result = await runMCodeCli(['computer', 'list-apps', '--json'])
    const envelope = parseJsonOutput<{ result: ComputerListAppsResult }>(result.stdout)

    expect(envelope.result.apps.some((app) => app.name === 'TextEdit')).toBe(true)
  })

  test('get-app-state returns TextEdit state', async () => {
    const result = await runMCodeCli(['computer', 'get-app-state', '--app', 'TextEdit', '--json'])
    const envelope = parseJsonOutput<{ result: ComputerSnapshotResult }>(result.stdout)

    expect(envelope.result.snapshot.app.name).toBe('TextEdit')
    expect(envelope.result.snapshot.elementCount).toBeGreaterThan(0)
    expect(envelope.result.snapshot.treeText).toContain('Window:')
  })

  test('click, type-text, and re-observe show inserted text', async () => {
    const before = parseJsonOutput<{ result: ComputerSnapshotResult }>(
      (await runMCodeCli(['computer', 'get-app-state', '--app', 'TextEdit', '--json'])).stdout
    )
    const textTarget = findRoleIndex(
      before.result.snapshot.treeText,
      /^\s*(\d+)\s+(text entry area|text field|HTML content)(?:\s|$)/m
    )
    expect(textTarget).toBeGreaterThanOrEqual(0)

    await runMCodeCli([
      'computer',
      'click',
      '--app',
      'TextEdit',
      '--element-index',
      String(textTarget)
    ])

    const marker = `mcode computer e2e ${Date.now()}`
    await runMCodeCli(['computer', 'type-text', '--app', 'TextEdit', '--text', marker])

    const after = parseJsonOutput<{ result: ComputerSnapshotResult }>(
      (await runMCodeCli(['computer', 'get-app-state', '--app', 'TextEdit', '--json'])).stdout
    )
    expect(after.result.snapshot.treeText).toContain(marker)
  })

  test('coordinate double-click activates a control, not just hover (STA-3433)', async () => {
    const result = await doubleClickTextEditWord()

    expect(result.action?.path).toBe('synthetic')
    expect(result.action?.verification).toMatchObject({
      state: 'unverified',
      reason: 'synthetic_input'
    })
    expect(result.replacedWord).toBe(true)
  })

  test('coordinate click reaches the captured native dialog window', async () => {
    expect(await clickCapturedTextEditOpenDialog()).toMatchObject({
      clickPath: 'synthetic',
      dialogClosed: true,
      dialogWasNew: true
    })
  })

  test('paste-text and hotkey verify TextEdit text replacement', async () => {
    const first = parseJsonOutput<{ result: ComputerActionResult }>(
      (
        await runMCodeCli([
          'computer',
          'paste-text',
          '--app',
          'TextEdit',
          '--text',
          'mcode paste first',
          '--no-screenshot',
          '--json'
        ])
      ).stdout
    )
    expect(first.result.action?.path).toBe('accessibility')
    expect(first.result.action?.verification?.state).toBe('verified')

    const selectAll = parseJsonOutput<{ result: ComputerActionResult }>(
      (
        await runMCodeCli([
          'computer',
          'hotkey',
          '--app',
          'TextEdit',
          '--key',
          'CmdOrCtrl+A',
          '--no-screenshot',
          '--json'
        ])
      ).stdout
    )
    expect(selectAll.result.action?.actionName).toBe('AXSelectAll')
    expect(selectAll.result.action?.verification?.state).toBe('verified')

    const marker = `mcode paste final ${Date.now()}`
    const second = parseJsonOutput<{ result: ComputerActionResult }>(
      (
        await runMCodeCli([
          'computer',
          'paste-text',
          '--app',
          'TextEdit',
          '--text',
          marker,
          '--no-screenshot',
          '--json'
        ])
      ).stdout
    )
    expect(second.result.action?.actionName).toBe('AXReplaceSelection')
    expect(second.result.action?.verification).toMatchObject({
      state: 'verified',
      property: 'focusedText',
      expected: marker
    })

    const after = parseJsonOutput<{ result: ComputerSnapshotResult }>(
      (
        await runMCodeCli([
          'computer',
          'get-app-state',
          '--app',
          'TextEdit',
          '--no-screenshot',
          '--json'
        ])
      ).stdout
    )
    expect(after.result.snapshot.treeText).toContain(marker)
    expect(after.result.snapshot.treeText).not.toContain('mcode paste first')
  })

  test('accessibility text actions work when TextEdit is not frontmost', async () => {
    const before = parseJsonOutput<{ result: ComputerSnapshotResult }>(
      (
        await runMCodeCli([
          'computer',
          'get-app-state',
          '--app',
          'TextEdit',
          '--restore-window',
          '--no-screenshot',
          '--json'
        ])
      ).stdout
    )
    const textTarget = findRoleIndex(
      before.result.snapshot.treeText,
      /^\s*(\d+)\s+(text entry area|text field|HTML content)(?:\s|$)/m
    )
    expect(textTarget).toBeGreaterThanOrEqual(0)

    await runMCodeCli([
      'computer',
      'click',
      '--app',
      'TextEdit',
      '--element-index',
      String(textTarget),
      '--restore-window',
      '--no-screenshot'
    ])

    await runMCodeCli([
      'computer',
      'paste-text',
      '--app',
      'TextEdit',
      '--text',
      'mcode unfocused first',
      '--no-screenshot'
    ])
    await activateFinder()

    const selectAll = parseJsonOutput<{ result: ComputerActionResult }>(
      (
        await runMCodeCli([
          'computer',
          'hotkey',
          '--app',
          'TextEdit',
          '--key',
          'CmdOrCtrl+A',
          '--no-screenshot',
          '--json'
        ])
      ).stdout
    )
    expect(selectAll.result.action?.actionName).toBe('AXSelectAll')
    expect(selectAll.result.action?.verification?.state).toBe('verified')

    const marker = `mcode unfocused final ${Date.now()}`
    const replacement = parseJsonOutput<{ result: ComputerActionResult }>(
      (
        await runMCodeCli([
          'computer',
          'paste-text',
          '--app',
          'TextEdit',
          '--text',
          marker,
          '--no-screenshot',
          '--json'
        ])
      ).stdout
    )
    expect(replacement.result.action?.actionName).toBe('AXReplaceSelection')
    expect(replacement.result.action?.verification).toMatchObject({
      state: 'verified',
      property: 'focusedText',
      expected: marker
    })

    const after = parseJsonOutput<{ result: ComputerSnapshotResult }>(
      (
        await runMCodeCli([
          'computer',
          'get-app-state',
          '--app',
          'TextEdit',
          '--no-screenshot',
          '--json'
        ])
      ).stdout
    )
    expect(after.result.snapshot.treeText).toContain(marker)
    expect(after.result.snapshot.treeText).not.toContain('mcode unfocused first')
  })

  test('screenshot capture returns image metadata', async () => {
    const result = await runMCodeCli(['computer', 'get-app-state', '--app', 'TextEdit', '--json'])
    const envelope = parseJsonOutput<{ result: ComputerSnapshotResult }>(result.stdout)

    expect(envelope.result.screenshotStatus.state).toBe('captured')
    expect(envelope.result.screenshot?.format).toBe('png')
    expect(envelope.result.screenshot?.data).toBeUndefined()
    expect(envelope.result.screenshot?.dataOmitted).toBe(true)
    expect(envelope.result.screenshot?.path).toContain('mcode-computer-use')
  })
})
