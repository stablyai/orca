import { readFileSync } from 'node:fs'
import type { CDPSession } from '@stablyai/playwright-test'

/** Returns the number of raw PTY input chunks captured by the IME harness. */
export function readPtyInputCount(inputLogPath: string): number {
  return readFileSync(inputLogPath, 'utf8').split(/\r?\n/).filter(Boolean).length
}

/** Reads raw PTY input chunks captured by the IME harness. */
export function readPtyInputs(inputLogPath: string): string[] {
  return readFileSync(inputLogPath, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as string)
}

/** Dispatches Chromium's native Microsoft Pinyin Backspace sequence. */
export async function dispatchWindowsImeBackspace(session: CDPSession): Promise<void> {
  await session.send('Input.dispatchKeyEvent', {
    type: 'rawKeyDown',
    key: 'Process',
    code: 'Backspace',
    windowsVirtualKeyCode: 229,
    nativeVirtualKeyCode: 229,
    text: '',
    unmodifiedText: ''
  })
  await session.send('Input.imeSetComposition', {
    text: '',
    selectionStart: 0,
    selectionEnd: 0
  })
  await session.send('Input.insertText', { text: '' })
  await session.send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'Process',
    code: 'Backspace',
    windowsVirtualKeyCode: 229,
    nativeVirtualKeyCode: 229
  })
  await session.send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'Backspace',
    code: 'Backspace',
    windowsVirtualKeyCode: 8,
    nativeVirtualKeyCode: 8
  })
}

/** Dispatches Chromium's native Microsoft Pinyin Shift-toggle sequence. */
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
