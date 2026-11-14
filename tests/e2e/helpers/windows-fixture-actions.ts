import { expect } from 'vitest'
import type {
  ComputerActionResult,
  ComputerSnapshotResult
} from '../../../src/shared/runtime-types'
import { findRoleIndex, parseJsonOutput, runOrcaCli } from './computer-driver'
import type {
  WindowsControlsFixture,
  WindowsFormsFixtureState,
  WindowsSemanticFixtureState
} from './windows-semantic-controls-fixture'

export async function treeText(app: string): Promise<string> {
  return parseJsonOutput<{ result: ComputerSnapshotResult }>(
    (await runOrcaCli(['computer', 'get-app-state', '--app', app, '--no-screenshot', '--json']))
      .stdout
  ).result.snapshot.treeText
}

export async function elementIndex(app: string, line: RegExp): Promise<number> {
  const text = await treeText(app)
  const index = findRoleIndex(text, line)
  expect(index, text).toBeGreaterThanOrEqual(0)
  return index
}

// Runs a UI Automation action, waits for its effect, and checks action.delivery against whether the window was activated.
export async function runPatternAction<
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
