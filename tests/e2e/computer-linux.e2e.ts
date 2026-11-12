import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import type {
  ComputerActionResult,
  ComputerListWindowsResult,
  ComputerSnapshotResult
} from '../../src/shared/runtime-types'
import {
  ensureOrcaRuntimeLaunched,
  ensureGeditLaunched,
  findRoleIndex,
  killGedit,
  openGeditWindow,
  parseJsonOutput,
  runOrcaCli
} from './helpers/computer-driver'

const isLinux = process.platform === 'linux'
const e2eOptIn = process.env.ORCA_COMPUTER_E2E === '1'

const GEDIT_TEXT_ROLE = /^\s*(\d+)\s+(text|text entry|entry|document|edit area)(?:\s|$)/im

async function geditState(windowArgs: string[], restore: boolean): Promise<ComputerSnapshotResult> {
  return parseJsonOutput<{ result: ComputerSnapshotResult }>(
    (
      await runOrcaCli([
        'computer',
        'get-app-state',
        '--app',
        'gedit',
        ...windowArgs,
        ...(restore ? ['--restore-window'] : []),
        '--no-screenshot',
        '--json'
      ])
    ).stdout
  ).result
}

async function focusGeditDocument(windowArgs: string[] = []): Promise<void> {
  const before = await geditState(windowArgs, true)
  const textIndex = findRoleIndex(before.snapshot.treeText, GEDIT_TEXT_ROLE)
  expect(textIndex).toBeGreaterThanOrEqual(0)

  await runOrcaCli([
    'computer',
    'click',
    '--app',
    'gedit',
    ...windowArgs,
    '--element-index',
    String(textIndex),
    '--restore-window',
    '--no-screenshot',
    '--json'
  ])
}

async function geditWindowArgs(title: string): Promise<string[]> {
  const listed = parseJsonOutput<{ result: ComputerListWindowsResult }>(
    (await runOrcaCli(['computer', 'list-windows', '--app', 'gedit', '--json'])).stdout
  )
  const window = listed.result.windows.find((candidate) => candidate.title.includes(title))
  expect(window).toBeDefined()
  return ['--window-index', String(window!.index)]
}

describe.skipIf(!isLinux || !e2eOptIn)('computer-use Linux e2e (gedit)', () => {
  beforeAll(async () => {
    await ensureOrcaRuntimeLaunched()
    await ensureGeditLaunched()
  })

  afterAll(async () => {
    await killGedit()
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

  test('type-text --element-index inserts into a background window field without focusing it', async () => {
    await openGeditWindow('gedit-front.txt')
    const targetWindow = await geditWindowArgs('gedit-target.txt')
    const frontWindow = await geditWindowArgs('gedit-front.txt')
    await focusGeditDocument(frontWindow)

    const target = await geditState(targetWindow, false)
    const documentIndex = findRoleIndex(target.snapshot.treeText, GEDIT_TEXT_ROLE)
    expect(documentIndex).toBeGreaterThanOrEqual(0)

    const marker = `orca-linux-element-${Date.now()}-élan-🚀`
    const typed = parseJsonOutput<{ result: ComputerActionResult }>(
      (
        await runOrcaCli([
          'computer',
          'type-text',
          '--app',
          'gedit',
          ...targetWindow,
          '--element-index',
          String(documentIndex),
          '--text',
          marker,
          '--no-screenshot',
          '--full-tree',
          '--json'
        ])
      ).stdout
    )
    expect(typed.result.action).toMatchObject({
      path: 'accessibility',
      verification: { state: 'verified', property: 'elementText' }
    })
    expect(typed.result.snapshot.treeText).toContain(marker)
    expect((await geditState(frontWindow, false)).snapshot.treeText).not.toContain(marker)
  })
})
