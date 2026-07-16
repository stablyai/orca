/**
 * Issue #8299 — macOS Shift+Space input-source switch also sends a literal space.
 *
 * Ghostty consumes the chord when the input source changes and does not encode
 * Space. Orca's xterm bypass policy has no input-source-switch guard, so
 * Shift+Space is not bypassed and reaches the PTY as a space.
 *
 * Re-run:
 *   pnpm exec vitest run --config config/vitest.config.ts \
 *     src/renderer/src/components/terminal-pane/repro-8299-shift-space-input-source.test.ts
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { shouldBypassXtermKeyboardEvent, type XtermBypassEvent } from './xterm-bypass-policy'

function event(
  partial: Partial<XtermBypassEvent> & Pick<XtermBypassEvent, 'type' | 'key'>
): XtermBypassEvent {
  return {
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...partial
  }
}

describe('issue #8299 Shift+Space is not consumed as input-source switch', () => {
  it('does not bypass Shift+Space keydown/keyup (xterm may encode a space)', () => {
    const opts = { isMac: true, hasSelection: false }
    for (const type of ['keydown', 'keyup'] as const) {
      // Browser often reports key=' ' for Space; some paths use 'Space'.
      expect(
        shouldBypassXtermKeyboardEvent(
          event({ type, key: ' ', code: 'Space', shiftKey: true }),
          opts
        )
      ).toBe(false)
      expect(
        shouldBypassXtermKeyboardEvent(
          event({ type, key: 'Space', code: 'Space', shiftKey: true }),
          opts
        )
      ).toBe(false)
    }
  })

  it('bypass policy has no Ghostty-style input-source-change short-circuit', () => {
    const source = readFileSync(join(__dirname, 'xterm-bypass-policy.ts'), 'utf8')
    // Comments mention "input-source switch" for IME 229 handling, but there is
    // no per-event KeyboardLayout.id / layout-changed consume path (Ghostty).
    expect(source).not.toMatch(/KeyboardLayout|layoutChanged|inputSourceChanged|layout\.id/)
    expect(source).not.toMatch(/key === ['"] ['"]|code === ['"]Space['"]/)
    const lifecycle = readFileSync(join(__dirname, 'use-terminal-pane-lifecycle.ts'), 'utf8')
    expect(lifecycle).toMatch(/attachCustomKeyEventHandler/)
    expect(lifecycle).not.toMatch(/inputSourceChanged|keyboardLayoutId|previousLayoutId/)
  })

  it('IME suppress path also leaves plain Shift+Space unsuppressed on macOS', async () => {
    const { shouldSuppressTerminalImeKeyboardEvent } = await import('./xterm-bypass-policy')
    expect(
      shouldSuppressTerminalImeKeyboardEvent(
        event({ type: 'keydown', key: ' ', code: 'Space', shiftKey: true }),
        {
          compositionActive: false,
          candidateKeyGuardActive: false,
          pendingCandidateKeyReleaseActive: false,
          isMac: true,
          isLinux: false
        }
      )
    ).toBe(false)
  })
})
