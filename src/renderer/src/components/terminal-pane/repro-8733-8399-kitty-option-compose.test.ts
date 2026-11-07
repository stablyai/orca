/**
 * Issues #8733 + #8399 — Option composition fails when kitty keyboard is active.
 *
 * #8733: French-PC, Option as Alt = Off. Shell composes `{` via AltGr; after
 * vim enables kitty protocol, Option chords become CSI-u Meta sequences.
 * Reload without restarting vim "fixes" it because SerializeAddon does not
 * persist kitty flags and the tracker restarts at 0 until vim re-pushes.
 *
 * #8399: German layout Option+L → `@`. Works in bare shell; Pi enables kitty
 * and the same path encodes physical L as `\x1b[108;3u` instead of `@`.
 *
 * Re-run:
 *   pnpm exec vitest run --config config/vitest.config.ts \
 *     src/renderer/src/components/terminal-pane/repro-8733-8399-kitty-option-compose.test.ts
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveTerminalShortcutAction } from './terminal-shortcut-policy'

function event(partial: {
  key: string
  code?: string
  altKey?: boolean
  shiftKey?: boolean
  metaKey?: boolean
  ctrlKey?: boolean
}): Parameters<typeof resolveTerminalShortcutAction>[0] {
  return {
    type: 'keydown',
    key: partial.key,
    code: partial.code,
    altKey: partial.altKey ?? false,
    shiftKey: partial.shiftKey ?? false,
    metaKey: partial.metaKey ?? false,
    ctrlKey: partial.ctrlKey ?? false,
    repeat: false
  }
}

const kittyActive = (): boolean => true
const kittyInactive = (): boolean => false

describe('issue #8733/#8399 kitty protocol overrides Option-as-Alt Off composition', () => {
  it('with macOptionAsAlt=false + kitty, Option+L encodes CSI-u not layout @', () => {
    // German: Option+L → @. Kitty path uses physical base key "l".
    const action = resolveTerminalShortcutAction(
      event({ key: '@', code: 'KeyL', altKey: true }),
      true,
      'false',
      0,
      false,
      undefined,
      undefined,
      kittyActive
    )
    expect(action).toEqual({
      type: 'sendInput',
      data: '\x1b[108;3u'
    })
  })

  it('with macOptionAsAlt=false + no kitty, Option+L is left for composition', () => {
    const action = resolveTerminalShortcutAction(
      event({ key: '@', code: 'KeyL', altKey: true }),
      true,
      'false',
      0,
      false,
      undefined,
      undefined,
      kittyInactive
    )
    // Null → xterm/Chromium composition path (German @ / French AltGr compose).
    expect(action).toBeNull()
  })

  it('French AltGr-style Option+quote becomes Meta CSI-u under kitty (vim)', () => {
    // French-PC: AltGr+' → `{`. With kitty active Orca sends physical key Meta.
    const action = resolveTerminalShortcutAction(
      event({ key: '{', code: 'Quote', altKey: true }),
      true,
      'false',
      2, // right Option / AltGr location
      false,
      undefined,
      undefined,
      kittyActive
    )
    expect(action).toEqual({
      type: 'sendInput',
      // "'" codepoint 39
      data: '\x1b[39;3u'
    })
  })

  it('documents that SerializeAddon path does not serialize kitty flags (reload clears tracker)', () => {
    const tracker = readFileSync(
      join(__dirname, '../../../../shared/terminal-kitty-keyboard-mode-tracker.ts'),
      'utf8'
    )
    // Design comment: xterm SerializeAddon does not serialize kitty flags —
    // reload loses protocol state until the TUI re-pushes (matches #8733).
    expect(tracker).toMatch(/SerializeAddon does not serialize kitty/i)
  })

  it('policy comment states kitty path applies for any mode other than true', () => {
    const source = readFileSync(join(__dirname, 'terminal-shortcut-policy.ts'), 'utf8')
    expect(source).toMatch(/kitty-protocol pane \(any other mode\)/)
    expect(source).toMatch(/macOptionAsAlt !== 'true'/)
  })
})
