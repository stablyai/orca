import { describe, expect, it } from 'vitest'
import {
  measureRetention,
  retentionCase,
  type RetentionCase
} from '../../../../shared/string-retention-measurement'
import { terminalRewriteOutputRenderRefreshDecision } from '../../lib/pane-manager/terminal-complex-script'
import { createPtyOutputProcessor } from './pty-transport'
import {
  markTerminalBracketedPasteInterrupted,
  observeTerminalBracketedPasteModeOutput
} from './terminal-bracketed-paste'

const PTY_CHUNK_CHARS = 16 * 1024
const PTYS = 512

const RETENTION_CASES: RetentionCase[] = [
  // This guards 16 KiB frame detachment, not production's O(panes) overwrite model.
  retentionCase({
    name: 'renderer pty title handed to the store',
    sourceChars: PTY_CHUNK_CHARS,
    samples: 2048,
    source: (index) =>
      `${'█'.repeat(PTY_CHUNK_CHARS)}\x1b]0;✳ Working… (esc to interrupt) pane-${index}\x07`,
    retain: (source) => {
      let storedTitle = ''
      const processor = createPtyOutputProcessor({
        onTitleChange: (normalized) => {
          storedTitle = normalized
        }
      })
      processor.processData(source, { onData: () => undefined })
      // Titles drain on a 0ms timer; flush instead of awaiting a macrotask.
      processor.flushPendingSideEffects()
      return storedTitle
    },
    verify: (first) => {
      expect(first).toBe('✳ Working… (esc to interrupt) pane-0')
    }
  }),

  // Production persists one interrupted-mode tail per terminal.
  retentionCase({
    name: 'bracketed paste interrupted mode tail',
    sourceChars: PTY_CHUNK_CHARS,
    samples: PTYS,
    // The tail lives in a module-private WeakMap, so the heap delta is the only signal.
    source: (index) => `${'x'.repeat(PTY_CHUNK_CHARS)}pane-${index}`,
    retain: (source) => {
      const terminal = { modes: { bracketedPasteMode: true } }
      markTerminalBracketedPasteInterrupted(terminal)
      observeTerminalBracketedPasteModeOutput(terminal, source)
      return terminal
    },
    verify: (first) => {
      expect(first.modes.bracketedPasteMode).toBe(true)
    }
  }),

  // The ≥13-char control arm proves detachment for one persisted rewrite tail per pane.
  retentionCase({
    name: 'rewrite csi scan tail',
    sourceChars: PTY_CHUNK_CHARS,
    samples: PTYS,
    source: (index) => `${'x'.repeat(PTY_CHUNK_CHARS)}pane-${index}\x1b[1;2;3;4;5;6;7;8;9`,
    retain: (source) =>
      terminalRewriteOutputRenderRefreshDecision(source, {
        previousChunkEndsWithCarriageReturn: false,
        previousRewriteCsiScanTail: ''
      }).nextRewriteCsiScanTail,
    verify: (first) => {
      expect(first).toBe('\x1b[1;2;3;4;5;6;7;8;9')
      expect(first.length).toBeGreaterThanOrEqual(13)
      expect(
        terminalRewriteOutputRenderRefreshDecision('K', {
          previousChunkEndsWithCarriageReturn: false,
          previousRewriteCsiScanTail: first
        }).prefersRenderRefresh
      ).toBe(true)
    }
  })
]

describe('detached string retention (renderer)', () => {
  it.each(RETENTION_CASES)('$name does not pin its source', (entry) => {
    const measured = measureRetention(entry)
    expect(measured.samples).toBe(entry.samples)
    entry.verify(measured.first as never)
    expect(
      measured.retainedMiB,
      `${entry.name}: retained ${measured.retainedMiB.toFixed(2)} MiB of a possible ${measured.pinnedMiB} MiB`
    ).toBeLessThan(measured.budgetMiB)
  })
})
