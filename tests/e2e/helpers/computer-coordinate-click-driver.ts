import type {
  ComputerActionResult,
  ComputerSnapshotResult
} from '../../../src/shared/runtime-types'
import {
  CliCommandError,
  delay,
  parseJsonOutput,
  runOrcaCli,
  runOrcaCliAllowFailure
} from './computer-cli-driver'

export async function doubleClickTextEditWord(): Promise<{
  action: ComputerActionResult['action']
  replacedWord: boolean
}> {
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

  const clickOutcome = await runOrcaCliAllowFailure([
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
  const clicked = clickOutcome.ok
    ? parseJsonOutput<{ result: ComputerActionResult }>(clickOutcome.result.stdout)
    : null
  if (!clickOutcome.ok && !deliveredFinalPressAbort(clickOutcome.failure.stdout, 2)) {
    throw new CliCommandError(clickOutcome.failure)
  }
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
  return {
    // An exact-count after-press abort still proves the synthetic HID path.
    action: clicked?.result.action ?? {
      path: 'synthetic',
      verification: { state: 'unverified', reason: 'synthetic_input' }
    },
    replacedWord: new RegExp(`${marker}\\s+wordword`).test(after.result.snapshot.treeText)
  }
}

export async function clickCapturedTextEditOpenDialog(): Promise<{
  clickPath: string | undefined
  dialogClosed: boolean
  dialogWasNew: boolean
}> {
  const before = parseJsonOutput<{
    result: { windows: { id?: number | null }[] }
  }>((await runOrcaCli(['computer', 'list-windows', '--app', 'TextEdit', '--json'])).stdout)
  const existingWindowIds = new Set(before.result.windows.map((window) => window.id))

  await runOrcaCli([
    'computer',
    'hotkey',
    '--app',
    'TextEdit',
    '--key',
    'CmdOrCtrl+O',
    '--restore-window',
    '--no-screenshot'
  ])
  const dialog = await waitForNewTextEditDialogWindow(existingWindowIds)
  const clickOutcome = await runOrcaCliAllowFailure([
    'computer',
    'click',
    '--app',
    'TextEdit',
    '--window-id',
    String(dialog.id),
    '--x',
    String(dialog.width - 140),
    '--y',
    String(dialog.height - 30),
    '--no-screenshot',
    '--json'
  ])
  let clickPath: string | undefined
  if (clickOutcome.ok) {
    clickPath = parseJsonOutput<{ result: ComputerActionResult }>(clickOutcome.result.stdout).result
      .action?.path
  } else if (deliveredFinalPressAbort(clickOutcome.failure.stdout, 1)) {
    // The dialogClosed postcondition decides a fully delivered Cancel click.
    clickPath = 'synthetic'
  } else {
    throw new CliCommandError(clickOutcome.failure)
  }
  const after = parseJsonOutput<{
    result: { windows: { id?: number | null }[] }
  }>((await runOrcaCli(['computer', 'list-windows', '--app', 'TextEdit', '--json'])).stdout)

  return {
    clickPath,
    dialogClosed: !after.result.windows.some((window) => window.id === dialog.id),
    dialogWasNew: !existingWindowIds.has(dialog.id)
  }
}

type FenceAbortEnvelope = {
  ok: false
  error: { code: string; data?: { deliveredPresses?: unknown; phase?: unknown } }
}

/** Accepts only an exact-count abort after the final press. */
export function deliveredFinalPressAbort(stdout: string, expectedClickCount: number): boolean {
  let envelope: FenceAbortEnvelope | undefined
  try {
    envelope = parseJsonOutput<FenceAbortEnvelope>(stdout)
  } catch {
    return false
  }
  if (!envelope || envelope.ok !== false || envelope.error.code !== 'window_not_focused') {
    return false
  }
  const data = envelope.error.data
  return (
    data?.phase === 'after-press' &&
    data?.deliveredPresses === expectedClickCount &&
    expectedClickCount >= 1
  )
}
// The Open panel must appear as a new list-windows id before clicking.
type TextEditWindowEntry = { id?: number | null; width: number; height: number }

async function waitForNewTextEditDialogWindow(
  existingWindowIds: Set<number | null | undefined>
): Promise<TextEditWindowEntry> {
  for (let attempt = 0; attempt < 12; attempt++) {
    const listing = parseJsonOutput<{ result: { windows: TextEditWindowEntry[] } }>(
      (await runOrcaCli(['computer', 'list-windows', '--app', 'TextEdit', '--json'])).stdout
    )
    const dialog = listing.result.windows.find(
      (window) => window.id !== null && window.id !== undefined && !existingWindowIds.has(window.id)
    )
    if (dialog) {
      return dialog
    }
    await delay(250)
  }
  throw new Error(
    'TextEdit Open dialog window did not appear in list-windows within 3s of the CmdOrCtrl+O hotkey'
  )
}
