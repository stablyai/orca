import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import type {
  ComputerActionResult,
  ComputerListWindowsResult,
  ComputerSnapshotResult
} from '../../src/shared/runtime-types'
import {
  closeSafariDraftFixture,
  ensureOrcaRuntimeLaunched,
  ensureSafariDraftFixtureLaunched,
  findRoleIndex,
  parseJsonOutput,
  runOrcaCli,
  type SafariDraftFixture
} from './helpers/computer-driver'

const isMac = process.platform === 'darwin'
const e2eOptIn = process.env.ORCA_COMPUTER_E2E === '1'

describe.skipIf(!isMac || !e2eOptIn)('computer-use macOS e2e (Safari web app)', () => {
  let fixture: SafariDraftFixture

  beforeAll(async () => {
    await ensureOrcaRuntimeLaunched()
    fixture = await ensureSafariDraftFixtureLaunched()
  })

  afterAll(async () => {
    await closeSafariDraftFixture()
  })

  test('fills a browser-hosted draft using fresh state between actions', async () => {
    const targetArgs = await safariFixtureWindowTargetArgs(fixture.title)
    let state = parseJsonOutput<{ result: ComputerSnapshotResult }>(
      (
        await runOrcaCli([
          'computer',
          'get-app-state',
          '--app',
          'com.apple.Safari',
          ...targetArgs,
          '--restore-window',
          '--no-screenshot',
          '--json'
        ])
      ).stdout
    )
    expect(state.result.snapshot.window.title).toContain(fixture.title)
    expect(state.result.snapshot.treeText).toContain('Draft empty')

    const recipientIndex = findRoleIndex(
      state.result.snapshot.treeText,
      /^\s*(\d+)\s+text field \(settable\) Recipient/m
    )
    expect(recipientIndex).toBeGreaterThanOrEqual(0)

    await runOrcaCli([
      'computer',
      'click',
      '--app',
      'com.apple.Safari',
      ...targetArgs,
      '--element-index',
      String(recipientIndex),
      '--restore-window',
      '--no-screenshot',
      '--json'
    ])

    const recipient = `agent-${Date.now()}@example.com`
    const recipientPaste = parseJsonOutput<{ result: ComputerActionResult }>(
      (
        await runOrcaCli([
          'computer',
          'paste-text',
          '--app',
          'com.apple.Safari',
          ...targetArgs,
          '--text',
          recipient,
          '--restore-window',
          '--no-screenshot',
          '--json'
        ])
      ).stdout
    )
    expect(recipientPaste.result.action?.verification).toMatchObject({
      state: 'verified',
      property: 'focusedText',
      expected: recipient
    })

    state = parseJsonOutput<{ result: ComputerSnapshotResult }>(
      (
        await runOrcaCli([
          'computer',
          'press-key',
          '--app',
          'com.apple.Safari',
          ...targetArgs,
          '--key',
          'Tab',
          '--restore-window',
          '--no-screenshot',
          '--json'
        ])
      ).stdout
    )
    expect(state.result.snapshot.treeText).toContain('focused UI element is')
    expect(state.result.snapshot.treeText).toContain('Body')

    const body = `hello browser draft ${Date.now()}`
    const bodyPaste = parseJsonOutput<{ result: ComputerActionResult }>(
      (
        await runOrcaCli([
          'computer',
          'paste-text',
          '--app',
          'com.apple.Safari',
          ...targetArgs,
          '--text',
          body,
          '--restore-window',
          '--no-screenshot',
          '--json'
        ])
      ).stdout
    )
    expect(bodyPaste.result.action?.verification).toMatchObject({
      state: 'verified',
      property: 'focusedText',
      expected: body
    })

    state = parseJsonOutput<{ result: ComputerSnapshotResult }>(
      (
        await runOrcaCli([
          'computer',
          'get-app-state',
          '--app',
          'com.apple.Safari',
          ...targetArgs,
          '--restore-window',
          '--no-screenshot',
          '--json'
        ])
      ).stdout
    )
    const saveIndex = findRoleIndex(state.result.snapshot.treeText, 'button Save draft')
    expect(saveIndex).toBeGreaterThanOrEqual(0)

    const saved = parseJsonOutput<{ result: ComputerActionResult }>(
      (
        await runOrcaCli([
          'computer',
          'click',
          '--app',
          'com.apple.Safari',
          ...targetArgs,
          '--element-index',
          String(saveIndex),
          '--restore-window',
          '--no-screenshot',
          '--json'
        ])
      ).stdout
    )
    expect(saved.result.action?.actionName).toBe('AXPress')
    expect(saved.result.snapshot.treeText).toContain(`Draft ready: ${recipient} / ${body}`)
  })
})

async function safariFixtureWindowTargetArgs(title: string): Promise<string[]> {
  const windows = parseJsonOutput<{ result: ComputerListWindowsResult }>(
    (await runOrcaCli(['computer', 'list-windows', '--app', 'com.apple.Safari', '--json'])).stdout
  ).result.windows
  const target = windows.find((window) => window.title.includes(title))
  expect(target).toBeTruthy()
  if (target?.id !== undefined && target.id !== null) {
    return ['--window-id', String(target.id)]
  }
  return ['--window-index', String(target?.index ?? 0)]
}
