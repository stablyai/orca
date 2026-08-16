import type { ITerminalAddon, Terminal } from '@xterm/xterm'

type JoinRange = [number, number]

// Fast Mono (github.com/Born2Root/Fast-Font) picks word-initial glyphs via
// `calt` rules that depend on the WHOLE word, so it must be shaped as whole
// words; the font is strictly monospace, so joined runs stay on the cell grid.
const FAST_FONT_PATTERN = /fast[ _-]?mono/i
const WORD_RUN_PATTERN = /[\p{L}\p{M}]{2,}/gu

/** Character joiner that hands whole letter runs to the renderer so fonts with
 *  word-dependent contextual shaping (the Fast Mono family) rasterize their
 *  designed word-initial emphasis instead of bolding every isolated letter. */
export class TerminalContextualShapingAddon implements ITerminalAddon {
  private terminal: Terminal | null = null
  private joinerId: number | null = null

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
