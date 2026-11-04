import type { ITerminalAddon, Terminal } from '@xterm/xterm'
import {
  acquireSharedLigatureFont,
  releaseSharedLigatureFont,
  type LigatureRange,
  type SharedLigatureFont
} from './shared-ligature-fonts'

const LIGATURE_CACHE_CHARACTER_BUDGET = 100_000
// Bound tiny attribute-segment caches; 2K entries exceeds one visible grid without permitting tens of thousands per pane.
const LIGATURE_CACHE_ENTRY_BUDGET = 2_048

function cloneRanges(ranges: readonly LigatureRange[]): LigatureRange[] {
  return ranges.map(([start, end]) => [start, end])
}

class LigatureRangeCache {
  private readonly entries = new Map<string, { ranges: LigatureRange[]; size: number }>()
  private cachedCharacters = 0

  get(text: string): LigatureRange[] | undefined {
    const entry = this.entries.get(text)
    if (!entry) {
      return undefined
    }
    this.entries.delete(text)
    this.entries.set(text, entry)
    // xterm mutates/merges joiner ranges; never expose cached tuples directly.
    return cloneRanges(entry.ranges)
  }

  set(text: string, ranges: readonly LigatureRange[]): void {
    if (text.length > LIGATURE_CACHE_CHARACTER_BUDGET) {
      return
    }
    const previous = this.entries.get(text)
    if (previous) {
      this.cachedCharacters -= previous.size
      this.entries.delete(text)
    }
    const entry = { ranges: cloneRanges(ranges), size: text.length }
    this.entries.set(text, entry)
    this.cachedCharacters += entry.size
    while (
      this.cachedCharacters > LIGATURE_CACHE_CHARACTER_BUDGET ||
      this.entries.size > LIGATURE_CACHE_ENTRY_BUDGET
    ) {
      const oldest = this.entries.entries().next().value as
        | [string, { ranges: LigatureRange[]; size: number }]
        | undefined
      if (!oldest) {
        break
      }
      this.entries.delete(oldest[0])
      this.cachedCharacters -= oldest[1].size
    }
  }

  clear(): void {
    this.entries.clear()
    this.cachedCharacters = 0
  }
}

/**
 * Joins ligatures from a font parsed once per font stack and shared across terminals, and caches
 * exact rows with bounded retention: TUIs repaint unchanged rows while upstream retries every ligature.
 */
export class TerminalLigaturesAddon implements ITerminalAddon {
  private readonly cache = new LigatureRangeCache()
  private terminal: Terminal | null = null
  private joinerId: number | null = null
  private font: SharedLigatureFont | null = null
  private unsubscribeFontLoaded: (() => void) | null = null

  activate(terminal: Terminal): void {
    if (!terminal.element) {
      throw new Error('Cannot activate TerminalLigaturesAddon before open is called')
    }
    this.terminal = terminal
    this.joinerId = terminal.registerCharacterJoiner((text) => this.join(text))
    terminal.element.style.fontFeatureSettings = '"calt" on'
  }

  private join(text: string): LigatureRange[] {
    const font = this.fontFor(this.terminal?.options.fontFamily ?? '')
    const cached = this.cache.get(text)
    if (cached) {
      return cached
    }
    const ranges = font.join(text)
    this.cache.set(text, ranges)
    return ranges
  }

  private fontFor(fontFamily: string): SharedLigatureFont {
    if (this.font?.fontFamily === fontFamily) {
      return this.font
    }
    this.releaseFont()
    this.cache.clear()
    const font = acquireSharedLigatureFont(fontFamily)
    this.font = font
    this.unsubscribeFontLoaded = font.onFontLoaded(() => {
      this.cache.clear()
      this.terminal?.refresh(0, this.terminal.rows - 1)
    })
    return font
  }

  private releaseFont(): void {
    this.unsubscribeFontLoaded?.()
    this.unsubscribeFontLoaded = null
    if (this.font) {
      releaseSharedLigatureFont(this.font)
      this.font = null
    }
  }

  dispose(): void {
    if (this.joinerId !== null) {
      this.terminal?.deregisterCharacterJoiner(this.joinerId)
      this.joinerId = null
    }
    this.releaseFont()
    if (this.terminal?.element) {
      this.terminal.element.style.fontFeatureSettings = ''
    }
    this.terminal = null
  }
}
