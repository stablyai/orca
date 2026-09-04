import type { ITerminalAddon, Terminal } from '@xterm/xterm'

type JoinRange = [number, number]

// Fast Mono (github.com/Born2Root/Fast-Font) picks word-initial glyphs via
// `calt` rules that depend on the WHOLE word, so it must be shaped as whole
// words. The font is monospace, but at fractional device sizes its advance
// drifts against the integer cell grid — the bundled addon-webgl patch
// quantizes joined-run ink to the grid, which keeps these runs cell-aligned.
const FAST_FONT_PATTERN = /fast[ _-]?mono/i
const WORD_RUN_PATTERN = /[\p{L}\p{M}]{2,}/gu

/** Character joiner that hands whole letter runs to the renderer so fonts with
 *  word-dependent contextual shaping (the Fast Mono family) rasterize their
 *  designed word-initial emphasis instead of bolding every isolated letter. */
export class TerminalContextualShapingAddon implements ITerminalAddon {
  private terminal: Terminal | null = null
  private joinerId: number | null = null

  /** Register the whole-word joiner on the terminal and refresh visible rows
   *  so already-rendered runs pick up word-dependent shaping immediately. */
  activate(terminal: Terminal): void {
    this.terminal = terminal
    this.joinerId = terminal.registerCharacterJoiner((text) => {
      // Why per call: the font family can change without re-activation.
      if (!FAST_FONT_PATTERN.test(terminal.options.fontFamily ?? '')) {
        return []
      }
      const ranges: JoinRange[] = []
      for (const match of text.matchAll(WORD_RUN_PATTERN)) {
        ranges.push([match.index, match.index + match[0].length])
      }
      return ranges
    })
    // Why: joiner ranges only apply to rows drawn after registration.
    terminal.refresh(0, terminal.rows - 1)
  }

  /** Deregister the joiner and drop the terminal reference. Safe to call
   *  twice, and safe when the terminal is already gone. */
  dispose(): void {
    if (this.joinerId !== null) {
      try {
        this.terminal?.deregisterCharacterJoiner(this.joinerId)
      } catch {
        /* ignore */
      }
      this.joinerId = null
    }
    this.terminal = null
  }
}
