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
  type WindowsControlsFixture,
  type WindowsFormsFixture,
  type WindowsFormsFixtureState,
  type WindowsSemanticFixture,
  type WindowsSemanticFixtureState
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

// Runs a UI Automation action, waits for its effect, and checks action.delivery against whether the window was activated.
async function runPatternAction<
  State extends WindowsSemanticFixtureState | WindowsFormsFixtureState
>(
  target: WindowsControlsFixture<State>,
  args: string[],
  effect: (state: State) => boolean,
  label: string
): Promise<{ result: ComputerActionResult; activated: boolean }> {
  const { waitForState } = target
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
        requireFixture(),
        ['scroll', '--app', app, '--element-index', String(item), '--direction', 'down'],
        (state) => state.listOffset > 0,
        'list scrolled down'
      )
    })

    test('ScrollToVisible brings an off-screen list item into view in the background', async () => {
      const { app } = requireFixture()
      const item = await elementIndex(app, /^\s*(\d+)\s+list item Semantic item 150(?:,|$)/m)

      const { activated } = await runPatternAction(
        requireFixture(),
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
        requireFixture(),
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
        requireFixture(),
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
        requireFixture(),
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

// Runs an action on the background WinForms window and checks it never came forward.
async function runInBackground(
  args: (app: string) => string[],
  effect: (state: WindowsFormsFixtureState) => boolean,
  label: string
): Promise<ComputerActionResult> {
  const target = requireFormsFixture()
  const { result, activated } = await runPatternAction(target, args(target.app), effect, label)
  expect(activated, JSON.stringify(result.action)).toBe(false)
  return result
}

async function formsIndex(line: RegExp): Promise<string> {
  return String(await elementIndex(requireFormsFixture().app, line))
}

describe.skipIf(!isWindows || !e2eOptIn || process.env.CI !== 'true')(
  'computer-use Windows Forms actions',
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

    test('type-text --element-index types into background text boxes at their caret', async () => {
      for (const [seed, text, field, expected] of [
        ['seed-name', ' café Ω 漢字', 'name', 'seed-name café Ω 漢字'],
        ['seed-notes', '\nsecond line', 'notes', 'seed-notes\r\nsecond line']
      ] as const) {
        const index = await formsIndex(
          new RegExp(`^\\s*(\\d+)\\s+(?:edit|document)\\b.*${seed}`, 'm')
        )
        const result = await runInBackground(
          (app) => ['type-text', '--app', app, '--element-index', index, '--text', text],
          (state) => state[field] === expected,
          `${seed} typed`
        )
        expect(result.action).toMatchObject({
          actionName: 'EM_REPLACESEL',
          verification: { state: 'verified', property: 'elementText' }
        })
      }
    })

    test('click presses a button and ticks a check box', async () => {
      const button = await formsIndex(/^\s*(\d+)\s+button Semantic press/m)
      await runInBackground(
        (app) => ['click', '--app', app, '--element-index', button],
        (state) => state.presses === 1,
        'button pressed'
      )
      const check = await formsIndex(/^\s*(\d+)\s+check box Semantic check/m)
      await runInBackground(
        (app) => ['click', '--app', app, '--element-index', check],
        (state) => state.checked,
        'check box ticked'
      )
    })

    test('set-value writes a text box and picks a combo box option', async () => {
      const field = await formsIndex(/^\s*(\d+)\s+edit\b.*seed-name/m)
      await runInBackground(
        (app) => ['set-value', '--app', app, '--element-index', field, '--value', 'replaced'],
        (state) => state.name === 'replaced',
        'text box replaced'
      )
      const combo = await formsIndex(/^\s*(\d+)\s+combo box\b/m)
      const result = await runInBackground(
        (app) => ['set-value', '--app', app, '--element-index', combo, '--value', 'Gamma'],
        (state) => state.combo === 'Gamma',
        'combo box at Gamma'
      )
      expect(result.action?.verification).toMatchObject({ state: 'verified', property: 'value' })
    })

    test('scroll pages a list box by its own rows', async () => {
      const row = await formsIndex(/^\s*(\d+)\s+list item Row 0\b/m)
      await runInBackground(
        (app) => ['scroll', '--app', app, '--element-index', row, '--direction', 'down'],
        (state) => state.listTop > 0,
        'list scrolled'
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
  const { stdout } = await promisify(execFile)(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      [
        'Add-Type -Name Foreground -Namespace OrcaE2E -MemberDefinition \'[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow(); [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);\'',
        '$owner = [uint32]0',
        '[void][OrcaE2E.Foreground]::GetWindowThreadProcessId([OrcaE2E.Foreground]::GetForegroundWindow(), [ref]$owner)',
        '$owner'
      ].join('; ')
    ],
    { windowsHide: true }
  )
  return Number.parseInt(stdout.trim(), 10)
}

// Character Map is a classic single-process Win32 app on every Windows image, so its pid owns its window.
describe.skipIf(!isWindows || !e2eOptIn || process.env.CI !== 'true')(
  'computer-use Windows launch-app',
  () => {
    let launchedPid: number | null = null

    beforeAll(async () => {
      await ensureOrcaRuntimeLaunched()
    })

    afterAll(async () => {
      if (launchedPid !== null) {
        await promisify(execFile)('taskkill.exe', ['/PID', String(launchedPid), '/F'], {
          windowsHide: true
        }).catch(() => {})
      }
      await stopOrcaRuntime()
    })

    test('launch-app starts an app and reports where it ended up', async () => {
      const result = parseJsonOutput<{ result: ComputerLaunchAppResult }>(
        (await runOrcaCli(['computer', 'launch-app', 'charmap', '--json'])).stdout
      ).result
      launchedPid = result.app.pid

      expect(result.launched).toBe(true)
      // CI never holds a foreground lock (no user input), so any app may take the foreground here;
      // what must hold is that delivery reports what happened.
      const ownsForeground = (await foregroundWindowOwnerPid()) === result.app.pid
      expect(result.delivery).toBe(ownsForeground ? 'foreground' : 'background')
    })
  }
)
