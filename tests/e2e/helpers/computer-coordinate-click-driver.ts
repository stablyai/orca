import type {
  ComputerActionResult,
  ComputerSnapshotResult
} from '../../../src/shared/runtime-types'
import { parseJsonOutput, runMCodeCli } from './computer-driver'

export async function doubleClickTextEditWord(): Promise<{
  action: ComputerActionResult['action']
  replacedWord: boolean
}> {
  const filler = Array(10).fill('wordword').join('\n')
  await runMCodeCli([
    'computer',
    'hotkey',
    '--app',
    'TextEdit',
    '--key',
    'CmdOrCtrl+A',
    '--no-screenshot'
  ])
  await runMCodeCli([
    'computer',
    'paste-text',
    '--app',
    'TextEdit',
    '--text',
    filler,
    '--no-screenshot'
  ])

  const clicked = parseJsonOutput<{ result: ComputerActionResult }>(
    (
      await runMCodeCli([
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
  const marker = `zz${Date.now()}zz`
  await runMCodeCli([
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
  return {
    action: clicked.result.action,
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
  }>((await runMCodeCli(['computer', 'list-windows', '--app', 'TextEdit', '--json'])).stdout)
  const existingWindowIds = new Set(before.result.windows.map((window) => window.id))

  const opened = parseJsonOutput<{ result: ComputerActionResult }>(
    (
      await runMCodeCli([
        'computer',
        'hotkey',
        '--app',
        'TextEdit',
        '--key',
        'CmdOrCtrl+O',
        '--restore-window',
        '--no-screenshot',
        '--json'
      ])
    ).stdout
  )
  const dialog = opened.result.snapshot.window
  const clicked = parseJsonOutput<{ result: ComputerActionResult }>(
    (
      await runMCodeCli([
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
    ).stdout
  )
  const after = parseJsonOutput<{
    result: { windows: { id?: number | null }[] }
  }>((await runMCodeCli(['computer', 'list-windows', '--app', 'TextEdit', '--json'])).stdout)

  return {
    clickPath: clicked.result.action?.path,
    dialogClosed: !after.result.windows.some((window) => window.id === dialog.id),
    dialogWasNew: !existingWindowIds.has(dialog.id)
  }
}
