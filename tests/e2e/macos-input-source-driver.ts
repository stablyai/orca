import { execFileSync } from 'node:child_process'
import path from 'node:path'

/**
 * Drives real macOS input sources and synthesized key events for the #12871 captures. Playwright's
 * own keyboard bypasses the IME entirely, so these go through TIS and System Events instead.
 */

export const TWO_SET_KOREAN_ID = 'com.apple.inputmethod.Korean.2SetKorean'
export const KOTOERI_ROMAJI_ID = 'com.apple.inputmethod.Kotoeri.RomajiTyping.Japanese'
export const KOTOERI_ROMAJI_PARENT_ID = 'com.apple.inputmethod.Kotoeri.RomajiTyping'
export const ABC_ID = 'com.apple.keylayout.ABC'

export const KEY = { left: 123, backspace: 51, returnKey: 36, s: 1, a: 0 } as const
export const MODIFIER_KEY = { command: 55, option: 58 } as const

const SELECT_INPUT_SOURCE = path.resolve(__dirname, 'select-input-source.swift')
const POST_MODIFIER_CHORD = path.resolve(__dirname, 'post-modifier-chord.swift')

export function selectInputSource(id: string): void {
  execFileSync('swift', [SELECT_INPUT_SOURCE, id])
}

export function enableInputSource(id: string): void {
  execFileSync('swift', ['-'], {
    input: `
import Carbon
let properties = [kTISPropertyInputSourceID: ${JSON.stringify(id)} as CFString] as CFDictionary
let sources = TISCreateInputSourceList(properties, true).takeRetainedValue() as! [TISInputSource]
guard !sources.isEmpty else { exit(3) }
for candidate in sources { TISEnableInputSource(candidate) }
exit(0)
`
  })
}

export function focusApp(processId: number): void {
  execFileSync('osascript', [
    '-e',
    `tell application "System Events" to set frontmost of first application process whose unix id is ${processId} to true`,
    '-e',
    'delay 0.3'
  ])
}

/** Switching the input source only takes effect on the next activation. */
export function bounceFocus(processId: number): void {
  execFileSync('osascript', ['-e', 'tell application "Finder" to activate', '-e', 'delay 0.4'])
  focusApp(processId)
}

export function typeKeyCodes(processId: number, keyCodes: readonly number[]): void {
  focusApp(processId)
  execFileSync('osascript', [
    '-e',
    'tell application "System Events"',
    '-e',
    `repeat with currentKeyCode in {${keyCodes.join(', ')}}`,
    '-e',
    'key code (currentKeyCode as integer)',
    '-e',
    'delay 0.12',
    '-e',
    'end repeat',
    '-e',
    'end tell'
  ])
}

/**
 * Types the chord with the modifier as its own key event. System Events folds the modifier into
 * the target key's flags instead, so its press and release never reach the app at all.
 */
export function pressChordWithSeparateModifier(
  processId: number,
  keyCode: number,
  modifier: 'command' | 'option'
): void {
  focusApp(processId)
  execFileSync('swift', [POST_MODIFIER_CHORD, String(MODIFIER_KEY[modifier]), String(keyCode)])
}

export function pressChord(
  processId: number,
  keyCode: number,
  modifier?: 'command' | 'option'
): void {
  focusApp(processId)
  execFileSync('osascript', [
    '-e',
    `tell application "System Events" to key code ${keyCode}${modifier ? ` using ${modifier} down` : ''}`
  ])
}
