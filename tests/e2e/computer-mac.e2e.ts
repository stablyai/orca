import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import type {
  ComputerActionResult,
  ComputerListAppsResult,
  ComputerSnapshotResult
} from '../../src/shared/runtime-types'
import {
  activateFinder,
  ensureOrcaRuntimeLaunched,
  ensureTextEditLaunched,
  findRoleIndex,
  killTextEdit,
  parseJsonOutput,
  runOrcaCli
} from './helpers/computer-driver'

const isMac = process.platform === 'darwin'
const e2eOptIn = process.env.ORCA_COMPUTER_E2E === '1'

describe.skipIf(!isMac || !e2eOptIn)('computer-use macOS e2e (TextEdit)', () => {
  beforeAll(async () => {
    await ensureOrcaRuntimeLaunched()
    await ensureTextEditLaunched()
  })

  afterAll(async () => {
    await killTextEdit()
  })

  test('list-apps includes TextEdit', async () => {
    const result = await runOrcaCli(['computer', 'list-apps', '--json'])
    const envelope = parseJsonOutput<{ result: ComputerListAppsResult }>(result.stdout)

    expect(envelope.result.apps.some((app) => app.name === 'TextEdit')).toBe(true)
  })

  test('get-app-state returns TextEdit state', async () => {
    const result = await runOrcaCli(['computer', 'get-app-state', '--app', 'TextEdit', '--json'])
    const envelope = parseJsonOutput<{ result: ComputerSnapshotResult }>(result.stdout)

    expect(envelope.result.snapshot.app.name).toBe('TextEdit')
    expect(envelope.result.snapshot.elementCount).toBeGreaterThan(0)
    expect(envelope.result.snapshot.treeText).toContain('Window:')
  })

  test('click, type-text, and re-observe show inserted text', async () => {
    const before = parseJsonOutput<{ result: ComputerSnapshotResult }>(
      (await runOrcaCli(['computer', 'get-app-state', '--app', 'TextEdit', '--json'])).stdout
    )
    const textTarget = findRoleIndex(
      before.result.snapshot.treeText,
      /^\s*(\d+)\s+(text entry area|text field|HTML content)(?:\s|$)/m
    )
    expect(textTarget).toBeGreaterThanOrEqual(0)

    await runOrcaCli([
      'computer',
      'click',
      '--app',
      'TextEdit',
      '--element-index',
      String(textTarget)
    ])

    const marker = `orca computer e2e ${Date.now()}`
    await runOrcaCli(['computer', 'type-text', '--app', 'TextEdit', '--text', marker])

    const after = parseJsonOutput<{ result: ComputerSnapshotResult }>(
      (await runOrcaCli(['computer', 'get-app-state', '--app', 'TextEdit', '--json'])).stdout
    )
    expect(after.result.snapshot.treeText).toContain(marker)
  })

  test('coordinate double-click activates a control, not just hover (STA-3433)', async () => {
    // Ten identical short lines: any first-lines click hits a word, and the
    // whole document stays inside the treeText value preview after editing.
    const filler = Array(10).fill('wordword').join('\n')
    await runOrcaCli([
      'computer',
      'hotkey',
      '--app',
      'TextEdit',
      '--key',
      'CmdOrCtrl+A',
      '--no-screenshot'
    ])
    await runOrcaCli([
      'computer',
      'paste-text',
      '--app',
      'TextEdit',
      '--text',
      filler,
      '--no-screenshot'
    ])

    // Word-select via coordinates: 40px in, 70px down lands inside a
    // "wordword" on one of the first lines whether or not the ruler is shown.
    const clicked = parseJsonOutput<{ result: ComputerActionResult }>(
      (
        await runOrcaCli([
          'computer',
          'click',
          '--app',
          'TextEdit',
          '--x',
          '40',
          '--y',
          '70',
          '--click-count',
          '2',
          '--no-screenshot',
          '--json'
        ])
      ).stdout
    )
    expect(clicked.result.action?.path).toBe('synthetic')
    expect(clicked.result.action?.verification).toMatchObject({
      state: 'unverified',
      reason: 'synthetic_input'
    })

    const marker = `zz${Date.now()}zz`
    await runOrcaCli([
      'computer',
      'type-text',
      '--app',
      'TextEdit',
      '--text',
      marker,
      '--no-screenshot'
    ])

    const after = parseJsonOutput<{ result: ComputerSnapshotResult }>(
      (
        await runOrcaCli([
          'computer',
          'get-app-state',
          '--app',
          'TextEdit',
          '--no-screenshot',
          '--json'
        ])
      ).stdout
    )
    // The double-click selected a mid-document word, so the typed marker must
    // be followed by more filler. A dropped press leaves the caret at the end
    // of the document and the marker only ever appends (the STA-3433 no-op).
    expect(after.result.snapshot.treeText).toMatch(new RegExp(`${marker}\\s+wordword`))
  })

  test('paste-text and hotkey verify TextEdit text replacement', async () => {
    const first = parseJsonOutput<{ result: ComputerActionResult }>(
      (
        await runOrcaCli([
          'computer',
          'paste-text',
          '--app',
          'TextEdit',
          '--text',
          'orca paste first',
          '--no-screenshot',
          '--json'
        ])
      ).stdout
    )
    expect(first.result.action?.path).toBe('accessibility')
    expect(first.result.action?.verification?.state).toBe('verified')

    const selectAll = parseJsonOutput<{ result: ComputerActionResult }>(
      (
        await runOrcaCli([
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

    const marker = `orca paste final ${Date.now()}`
    const second = parseJsonOutput<{ result: ComputerActionResult }>(
      (
        await runOrcaCli([
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
        await runOrcaCli([
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
    expect(after.result.snapshot.treeText).not.toContain('orca paste first')
  })

  test('accessibility text actions work when TextEdit is not frontmost', async () => {
    const before = parseJsonOutput<{ result: ComputerSnapshotResult }>(
      (
        await runOrcaCli([
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

    await runOrcaCli([
      'computer',
      'click',
      '--app',
      'TextEdit',
      '--element-index',
      String(textTarget),
      '--restore-window',
      '--no-screenshot'
    ])

    await runOrcaCli([
      'computer',
      'paste-text',
      '--app',
      'TextEdit',
      '--text',
      'orca unfocused first',
      '--no-screenshot'
    ])
    await activateFinder()

    const selectAll = parseJsonOutput<{ result: ComputerActionResult }>(
      (
        await runOrcaCli([
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

    const marker = `orca unfocused final ${Date.now()}`
    const replacement = parseJsonOutput<{ result: ComputerActionResult }>(
      (
        await runOrcaCli([
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
        await runOrcaCli([
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
    expect(after.result.snapshot.treeText).not.toContain('orca unfocused first')
  })

  test('screenshot capture returns image metadata', async () => {
    const result = await runOrcaCli(['computer', 'get-app-state', '--app', 'TextEdit', '--json'])
    const envelope = parseJsonOutput<{ result: ComputerSnapshotResult }>(result.stdout)

    expect(envelope.result.screenshotStatus.state).toBe('captured')
    expect(envelope.result.screenshot?.format).toBe('png')
    expect(envelope.result.screenshot?.data).toBeUndefined()
    expect(envelope.result.screenshot?.dataOmitted).toBe(true)
    expect(envelope.result.screenshot?.path).toContain('orca-computer-use')
  })
})
