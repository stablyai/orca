import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import type {
  ComputerActionResult,
  ComputerLaunchAppResult,
  ComputerSnapshotResult
} from '../../src/shared/runtime-types'
import {
  ensureOrcaRuntimeLaunched,
  findRoleIndex,
  parseJsonOutput,
  runOrcaCli,
  stopOrcaRuntime
} from './helpers/computer-driver'
import {
  launchWindowsFormsFixture,
  launchWindowsSemanticFixture,
  type WindowsFormsFixture,
  type WindowsFormsFixtureState,
  type WindowsSemanticFixture,
  type WindowsSemanticFixtureState
} from './helpers/windows-semantic-controls-fixture'
import {
  closeWindowFixture,
  launchWindowFixture,
  type WindowFixture
} from './helpers/windows-form-fixture'

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

// Runs a UI Automation action, waits for its effect, and checks action.delivery against whether the window was activated.
async function runPatternAction(
  args: string[],
  effect: (state: WindowsSemanticFixtureState) => boolean,
  label: string
): Promise<{ result: ComputerActionResult; activated: boolean }> {
  const { waitForState } = requireFixture()
  const before = await waitForState((state) => !state.active, 'fixture window inactive')
  const result = parseJsonOutput<{ result: ComputerActionResult }>(
    (await runOrcaCli(['computer', ...args, '--no-screenshot', '--json'])).stdout
  ).result
  expect(result.action?.path).toBe('accessibility')
  const after = await waitForState(effect, label)
  const activated = after.activations > before.activations
  expect(result.action?.delivery, after.events.join('\n')).toBe(
    activated ? 'foreground' : 'background'
  )
  return { result, activated }
}

// The fixture shows real windows and hands foreground back to its holder, so this runs only on CI.
describe.skipIf(!isWindows || !e2eOptIn || process.env.CI !== 'true')(
  'computer-use Windows UI Automation actions',
  () => {
    beforeAll(async () => {
      await ensureOrcaRuntimeLaunched()
      fixture = await launchWindowsSemanticFixture()
    })

    afterAll(async () => {
      await fixture?.close()
      fixture = null
      await stopOrcaRuntime()
    })

    test('scroll pages a list through ScrollPattern and reports whether the window came forward', async () => {
      const { app } = requireFixture()
      const item = await elementIndex(app, /^\s*(\d+)\s+list item Semantic item 0(?:,|$)/m)

      await runPatternAction(
        ['scroll', '--app', app, '--element-index', String(item), '--direction', 'down'],
        (state) => state.listOffset > 0,
        'list scrolled down'
      )
    })

    test('ScrollToVisible brings an off-screen list item into view in the background', async () => {
      const { app } = requireFixture()
      const item = await elementIndex(app, /^\s*(\d+)\s+list item Semantic item 150(?:,|$)/m)

      const { activated } = await runPatternAction(
        [
          'perform-secondary-action',
          '--app',
          app,
          '--element-index',
          String(item),
          '--action',
          'ScrollToVisible'
        ],
        (state) => state.listOffset <= 150 && 150 < state.listOffset + state.listViewport,
        'item 150 in the list viewport'
      )
      expect(activated).toBe(false)
    })

    test('Expand and Collapse drive a tree item through ExpandCollapsePattern', async () => {
      const { app } = requireFixture()
      const collapsed = await elementIndex(
        app,
        /^\s*(\d+)\s+tree view item Semantic branch,.*Secondary Actions:.*\bExpand\b/m
      )
      await runPatternAction(
        [
          'perform-secondary-action',
          '--app',
          app,
          '--element-index',
          String(collapsed),
          '--action',
          'Expand'
        ],
        (state) => state.branchExpanded,
        'branch expanded'
      )

      const expanded = await elementIndex(
        app,
        /^\s*(\d+)\s+tree view item Semantic branch,.*Secondary Actions:.*\bCollapse\b/m
      )
      await runPatternAction(
        [
          'perform-secondary-action',
          '--app',
          app,
          '--element-index',
          String(expanded),
          '--action',
          'Collapse'
        ],
        (state) => !state.branchExpanded,
        'branch collapsed'
      )
    })

    test('set-value moves a slider through RangeValuePattern', async () => {
      const { app } = requireFixture()
      const slider = await elementIndex(app, /^\s*(\d+)\s+slider Semantic level(?:,|$)/m)

      const { result } = await runPatternAction(
        ['set-value', '--app', app, '--element-index', String(slider), '--value', '42'],
        (state) => state.level === 42,
        'slider at 42'
      )
      expect(result.action?.verification).toMatchObject({ state: 'verified', property: 'value' })
    })
  }
)

let formsFixture: WindowsFormsFixture | null = null

function requireFormsFixture(): WindowsFormsFixture {
  if (!formsFixture) {
    throw new Error('Windows Forms fixture has not been launched')
  }
  return formsFixture
}

// Types into a background WinForms text box by element index and checks the window never came forward.
async function typeIntoField(
  seed: string,
  text: string,
  landed: (state: WindowsFormsFixtureState) => boolean
): Promise<ComputerActionResult> {
  const { app, waitForState } = requireFormsFixture()
  const before = await waitForState((state) => !state.active, 'fixture window inactive')
  const field = await elementIndex(
    app,
    new RegExp(`^\\s*(\\d+)\\s+(?:edit|document)\\b.*${seed}`, 'm')
  )
  const result = parseJsonOutput<{ result: ComputerActionResult }>(
    (
      await runOrcaCli([
        'computer',
        'type-text',
        '--app',
        app,
        '--element-index',
        String(field),
        '--text',
        text,
        '--no-screenshot',
        '--json'
      ])
    ).stdout
  ).result
  const after = await waitForState(landed, `${seed} typed`)
  expect(after.activations, after.events.join('\n')).toBe(before.activations)
  expect(result.action).toMatchObject({
    path: 'accessibility',
    actionName: 'EM_REPLACESEL',
    delivery: 'background',
    verification: { state: 'verified', property: 'elementText' }
  })
  return result
}

describe.skipIf(!isWindows || !e2eOptIn || process.env.CI !== 'true')(
  'computer-use Windows Forms text entry',
  () => {
    beforeAll(async () => {
      await ensureOrcaRuntimeLaunched()
      formsFixture = await launchWindowsFormsFixture()
    })

    afterAll(async () => {
      await formsFixture?.close()
      formsFixture = null
      await stopOrcaRuntime()
    })

    test('type-text --element-index types Unicode into a background text box at its caret', async () => {
      await typeIntoField(
        'seed-name',
        ' café Ω 漢字',
        (state) => state.name === 'seed-name café Ω 漢字'
      )
    })

    test('type-text --element-index keeps line breaks in a background multiline text box', async () => {
      await typeIntoField(
        'seed-notes',
        '\nsecond line',
        (state) => state.notes === 'seed-notes\r\nsecond line'
      )
    })

    test('keys refuse in the background and send nothing', async () => {
      const { app, readState, waitForState } = requireFormsFixture()
      const before = await waitForState((state) => !state.active, 'fixture window inactive')
      const failure = await runOrcaCli([
        'computer',
        'press-key',
        '--app',
        app,
        '--key',
        'Return',
        '--no-screenshot',
        '--json'
      ]).then(
        () => 'press-key unexpectedly succeeded',
        (error: unknown) => (error instanceof Error ? error.message : String(error))
      )
      expect(failure).toMatch(/"code":\s*"background_unavailable"/)
      expect(failure).toContain('type-text --element-index')
      const after = await readState()
      expect(after.activations).toBe(before.activations)
      expect(after.notes).toBe(before.notes)
    })
  }
)


async function foregroundWindowOwnerPid(): Promise<number> {
  const { stdout } = await promisify(execFile)('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    [
      'Add-Type -Name Foreground -Namespace OrcaE2E -MemberDefinition \'[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow(); [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);\'',
      '$owner = [uint32]0',
      '[void][OrcaE2E.Foreground]::GetWindowThreadProcessId([OrcaE2E.Foreground]::GetForegroundWindow(), [ref]$owner)',
      '$owner'
    ].join('; ')
  ])
  return Number.parseInt(stdout.trim(), 10)
}

// Character Map is a classic single-process Win32 app on every Windows image, so its pid owns its window.
describe.skipIf(!isWindows || !e2eOptIn || process.env.CI !== 'true')(
  'computer-use Windows launch-app',
  () => {
    let holder: WindowFixture | null = null
    let launchedPid: number | null = null

    beforeAll(async () => {
      await ensureOrcaRuntimeLaunched()
      holder = await launchWindowFixture(
        "$form.Text = 'orca-e2e-launch-holder'",
        '$form.Activate()'
      )
    })

    afterAll(async () => {
      if (launchedPid !== null) {
        await promisify(execFile)('taskkill.exe', ['/PID', String(launchedPid), '/F']).catch(
          () => {}
        )
      }
      if (holder) {
        await closeWindowFixture(holder)
      }
      await stopOrcaRuntime()
    })

    test('launch-app starts an app without taking the foreground', async () => {
      const result = parseJsonOutput<{ result: ComputerLaunchAppResult }>(
        (await runOrcaCli(['computer', 'launch-app', 'charmap', '--json'])).stdout
      ).result
      launchedPid = result.app.pid

      expect(result.launched).toBe(true)
      expect(result.delivery).toBe('background')
      expect(await foregroundWindowOwnerPid()).not.toBe(result.app.pid)
    })
  }
)
