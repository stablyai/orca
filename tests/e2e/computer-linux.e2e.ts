import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import type { ComputerActionResult, ComputerSnapshotResult } from '../../src/shared/runtime-types'
import {
  ensureOrcaRuntimeLaunched,
  ensureGeditLaunched,
  findRoleIndex,
  killGedit,
  parseJsonOutput,
  runOrcaCli
} from './helpers/computer-driver'

const isLinux = process.platform === 'linux'
const e2eOptIn = process.env.ORCA_COMPUTER_E2E === '1'

async function focusGeditDocument(): Promise<void> {
  const before = parseJsonOutput<{ result: ComputerSnapshotResult }>(
    (
      await runOrcaCli([
        'computer',
        'get-app-state',
        '--app',
        'gedit',
        '--restore-window',
        '--no-screenshot',
        '--json'
      ])
    ).stdout
  )
  const textIndex = findRoleIndex(
    before.result.snapshot.treeText,
    /^\s*(\d+)\s+(text|text entry|entry|document|edit area)(?:\s|$)/im
  )
  expect(textIndex).toBeGreaterThanOrEqual(0)

  await runOrcaCli([
    'computer',
    'click',
    '--app',
    'gedit',
    '--element-index',
    String(textIndex),
    '--restore-window',
    '--no-screenshot',
    '--json'
  ])
}

describe.skipIf(!isLinux || !e2eOptIn)('computer-use Linux e2e (gedit)', () => {
  beforeAll(async () => {
    await ensureOrcaRuntimeLaunched()
    await ensureGeditLaunched()
  })

  afterAll(async () => {
    await killGedit()
  })

  test('gedit exposes a basic accessibility tree', async () => {
    const result = await runOrcaCli(['computer', 'get-app-state', '--app', 'gedit', '--json'])
    const envelope = parseJsonOutput<{ result: ComputerSnapshotResult }>(result.stdout)

    expect(envelope.result.snapshot.elementCount).toBeGreaterThan(0)
    expect(envelope.result.snapshot.coordinateSpace).toBe('window')
    expect(envelope.result.snapshot.truncation?.truncated).toBe(false)
    expect(envelope.result.screenshot?.data).toBeUndefined()
    expect(envelope.result.screenshot?.path).toContain('orca-computer-use')
  })

  test('click and type-text insert into the focused document through AT-SPI', async () => {
    await focusGeditDocument()

    const marker = ` orca-linux-type-${Date.now()}-élan-🚀`
    const typed = parseJsonOutput<{ result: ComputerActionResult }>(
      (
        await runOrcaCli([
          'computer',
          'type-text',
          '--app',
          'gedit',
          '--text',
          marker,
          '--restore-window',
          '--no-screenshot',
          '--json'
        ])
      ).stdout
    )
    expect(typed.result.action?.path).toBe('accessibility')
    expect(typed.result.snapshot.treeText).toContain(marker.trim())
  })

  test('paste-text mutates the test-owned document', async () => {
    await focusGeditDocument()

    const marker = `orca-linux-paste-${Date.now()}-café-🚀`
    const action = parseJsonOutput<{ result: ComputerActionResult }>(
      (
        await runOrcaCli([
          'computer',
          'paste-text',
          '--app',
          'gedit',
          '--text',
          marker,
          '--restore-window',
          '--no-screenshot',
          '--json'
        ])
      ).stdout
    )
    expect(action.result.action?.path).toBe('accessibility')
    expect(action.result.action?.verification).toMatchObject({
      state: 'verified',
      property: 'focusedText'
    })

    const after = parseJsonOutput<{ result: ComputerSnapshotResult }>(
      (
        await runOrcaCli([
          'computer',
          'get-app-state',
          '--app',
          'gedit',
          '--no-screenshot',
          '--json'
        ])
      ).stdout
    )
    expect(after.result.snapshot.treeText).toContain(marker)
  })
})
