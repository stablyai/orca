import { readFileSync } from 'node:fs'
import type { CDPSession } from '@stablyai/playwright-test'

export function readPtyInputs(inputLogPath: string): string[] {
  return readFileSync(inputLogPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as string)
}

export function readPtyInputCount(inputLogPath: string): number {
  return readPtyInputs(inputLogPath).length
}

export async function dispatchWindowsImeShiftToggle(session: CDPSession): Promise<void> {
  await session.send('Input.dispatchKeyEvent', {
    type: 'rawKeyDown',
    key: 'Process',
    code: 'ShiftLeft',
    windowsVirtualKeyCode: 229,
    nativeVirtualKeyCode: 229,
    modifiers: 8
  })
  await session.send('Input.dispatchKeyEvent', {
    type: 'rawKeyDown',
    key: 'Shift',
    code: 'ShiftLeft',
    windowsVirtualKeyCode: 16,
    nativeVirtualKeyCode: 16,
    modifiers: 8
  })
  await session.send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'Process',
    code: 'ShiftLeft',
    windowsVirtualKeyCode: 229,
    nativeVirtualKeyCode: 229,
    modifiers: 8
  })
  await session.send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'Shift',
    code: 'ShiftLeft',
    windowsVirtualKeyCode: 16,
    nativeVirtualKeyCode: 16
  })
  await session.send('Input.insertText', { text: 's' })
}
