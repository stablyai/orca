import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import type { ComputerActionResult, ComputerSnapshotResult } from '../../src/shared/runtime-types'
import {
  ensureOrcaRuntimeLaunched,
  findRoleIndex,
  parseJsonOutput,
  runOrcaCli,
  stopOrcaRuntime
} from './helpers/computer-driver'
import {
  launchWindowsSemanticFixture,
  type WindowsSemanticFixture
} from './helpers/windows-semantic-controls-fixture'

const isWindows = process.platform === 'win32'
const e2eOptIn = process.env.ORCA_COMPUTER_E2E === '1'

let fixture: WindowsSemanticFixture | null = null

function requireFixture(): WindowsSemanticFixture {
  if (!fixture) {
    throw new Error('Windows semantic controls fixture has not been launched')
  }
  return fixture
}

async function treeText(app: string): Promise<string> {
  return parseJsonOutput<{ result: ComputerSnapshotResult }>(
    (await runOrcaCli(['computer', 'get-app-state', '--app', app, '--no-screenshot', '--json']))
      .stdout
  ).result.snapshot.treeText
}

async function elementIndex(app: string, line: RegExp): Promise<number> {
  const text = await treeText(app)
  const index = findRoleIndex(text, line)
  expect(index, text).toBeGreaterThanOrEqual(0)
  return index
}

async function runAction(args: string[]): Promise<ComputerActionResult> {
  return parseJsonOutput<{ result: ComputerActionResult }>(
    (await runOrcaCli(['computer', ...args, '--no-screenshot', '--json'])).stdout
  ).result
}

function expectBackgroundAccessibility(result: ComputerActionResult): void {
  expect(result.action).toMatchObject({ path: 'accessibility', delivery: 'background' })
}

async function expectNeverActivated(): Promise<void> {
  expect((await requireFixture().readState()).activations).toBe(0)
}

describe.skipIf(!isWindows || !e2eOptIn)('computer-use Windows background UI Automation', () => {
  beforeAll(async () => {
    await ensureOrcaRuntimeLaunched()
    fixture = await launchWindowsSemanticFixture()
    // The fixture opens behind the foreground window; every check below depends on that.
    await expectNeverActivated()
  })

  afterAll(async () => {
    await fixture?.close()
    fixture = null
    await stopOrcaRuntime()
  })

  test('scroll pages a list through ScrollPattern without activating the window', async () => {
    const { app, waitForState } = requireFixture()
    const item = await elementIndex(app, /^\s*(\d+)\s+list item Semantic item 0(?:,|$)/m)

    const result = await runAction([
      'scroll',
      '--app',
      app,
      '--element-index',
      String(item),
      '--direction',
      'down'
    ])

    expectBackgroundAccessibility(result)
    await waitForState((state) => state.listOffset > 0, 'list scrolled down')
    await expectNeverActivated()
  })

  test('ScrollToVisible brings an off-screen list item into view', async () => {
    const { app, waitForState } = requireFixture()
    const item = await elementIndex(app, /^\s*(\d+)\s+list item Semantic item 150(?:,|$)/m)

    const result = await runAction([
      'perform-secondary-action',
      '--app',
      app,
      '--element-index',
      String(item),
      '--action',
      'ScrollToVisible'
    ])

    expectBackgroundAccessibility(result)
    await waitForState(
      (state) => state.listOffset <= 150 && 150 < state.listOffset + state.listViewport,
      'item 150 in the list viewport'
    )
    await expectNeverActivated()
  })

  test('Expand and Collapse drive a tree item through ExpandCollapsePattern', async () => {
    const { app, waitForState } = requireFixture()
    const collapsed = await elementIndex(
      app,
      /^\s*(\d+)\s+tree item Semantic branch,.*Secondary Actions:.*\bExpand\b/m
    )
    expectBackgroundAccessibility(
      await runAction([
        'perform-secondary-action',
        '--app',
        app,
        '--element-index',
        String(collapsed),
        '--action',
        'Expand'
      ])
    )
    await waitForState((state) => state.branchExpanded, 'branch expanded')

    const expanded = await elementIndex(
      app,
      /^\s*(\d+)\s+tree item Semantic branch,.*Secondary Actions:.*\bCollapse\b/m
    )
    expectBackgroundAccessibility(
      await runAction([
        'perform-secondary-action',
        '--app',
        app,
        '--element-index',
        String(expanded),
        '--action',
        'Collapse'
      ])
    )
    await waitForState((state) => !state.branchExpanded, 'branch collapsed')
    await expectNeverActivated()
  })

  test('set-value moves a slider through RangeValuePattern', async () => {
    const { app, waitForState } = requireFixture()
    const slider = await elementIndex(app, /^\s*(\d+)\s+slider Semantic level(?:,|$)/m)

    const result = await runAction([
      'set-value',
      '--app',
      app,
      '--element-index',
      String(slider),
      '--value',
      '42'
    ])

    expectBackgroundAccessibility(result)
    expect(result.action?.verification).toMatchObject({ state: 'verified', property: 'value' })
    await waitForState((state) => state.level === 42, 'slider at 42')
    await expectNeverActivated()
  })
})
