// Upstream packaging bug: @xterm/addon-ligatures declares a missing module
// entry. config/patches/@xterm__addon-ligatures* keeps the runtime import valid.
import { LigaturesAddon } from '@xterm/addon-ligatures'
import type { Terminal } from '@xterm/xterm'

type LigatureRange = [number, number]
type CharacterJoiner = (text: string) => LigatureRange[]

const LIGATURE_CACHE_CHARACTER_BUDGET = 100_000
// Why: short attribute segments can otherwise create tens of thousands of Map
// entries per pane; 2K is still far beyond one visible grid's working set.
const LIGATURE_CACHE_ENTRY_BUDGET = 2_048

function cloneRanges(ranges: readonly LigatureRange[]): LigatureRange[] {
  return ranges.map(([start, end]) => [start, end])
}

class LigatureRangeCache {
  private readonly entries = new Map<string, { ranges: LigatureRange[]; size: number }>()
  private cachedCharacters = 0
  generation = 0

  get(text: string): LigatureRange[] | undefined {
    const entry = this.entries.get(text)
    if (!entry) {
      return undefined
    }
    this.entries.delete(text)
    this.entries.set(text, entry)
    // Why: xterm translates and merges joiner ranges in place, so callers must
    // never receive the cache's retained tuples.
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
    this.generation++
  }
}

function createCachedCharacterJoiner(
  terminal: Terminal,
  joiner: CharacterJoiner,
  cache: LigatureRangeCache
): CharacterJoiner {
  let cachedFontFamily = terminal.options.fontFamily
  return (text) => {
    const fontFamily = terminal.options.fontFamily
    if (fontFamily !== cachedFontFamily) {
      cachedFontFamily = fontFamily
      cache.clear()
    }
    const cached = cache.get(text)
    if (cached) {
      return cached
    }
    const generationBeforeJoin = cache.generation
    const ranges = joiner(text)
    // Why: the addon refreshes when async font discovery completes. If that
    // happened during this call, do not repopulate the cleared fallback data.
    if (cache.generation === generationBeforeJoin) {
      cache.set(text, ranges)
    }
    return ranges
  }
}

/** LigaturesAddon with a bounded exact-row cache around its character joiner.
 *  Active TUIs repaint mostly unchanged rows, while the upstream fallback
 *  matcher otherwise retries every known ligature at every character. */
export class TerminalLigaturesAddon extends LigaturesAddon {
  override activate(terminal: Terminal): void {
    const cache = new LigatureRangeCache()
    const terminalForAddon = new Proxy(terminal, {
      get(target, property) {
        if (property === 'registerCharacterJoiner') {
          return (joiner: CharacterJoiner): number =>
            target.registerCharacterJoiner(createCachedCharacterJoiner(target, joiner, cache))
        }
        if (property === 'refresh') {
          return (start: number, end: number): void => {
            cache.clear()
            target.refresh(start, end)
          }
        }
        const value = Reflect.get(target, property, target) as unknown
        return typeof value === 'function' ? value.bind(target) : value
      }
    })
    super.activate(terminalForAddon)
  }
}
