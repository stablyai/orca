import type { NavigationLocation } from './code-intelligence-types'
import { normalizeDebugPathKey } from '../debug/debug-session-paths'

export const MERGE_LINES = 4
const MAX_ENTRIES = 100

function samePlace(
  a: Omit<NavigationLocation, 'time'>,
  b: Omit<NavigationLocation, 'time'>
): boolean {
  return (
    normalizeDebugPathKey(a.filePath) === normalizeDebugPathKey(b.filePath) &&
    Math.abs(a.line - b.line) < MERGE_LINES
  )
}

/**
 * IntelliJ-style Back/Forward editor navigation stack (`Alt+Left` / `Alt+Right`).
 * Recording a jump pushes both the jump origin and destination while coalescing
 * nearby cursor locations within `MERGE_LINES` lines.
 */
export class CodeNavigationHistory {
  entries: NavigationLocation[] = []
  index = -1

  constructor(private readonly now: () => number = Date.now) {}

  get current(): NavigationLocation | null {
    return this.entries[this.index] ?? null
  }

  canGoBack(): boolean {
    return this.index > 0
  }

  canGoForward(): boolean {
    return this.index >= 0 && this.index < this.entries.length - 1
  }

  recordJump(
    origin: Omit<NavigationLocation, 'time'>,
    destination: Omit<NavigationLocation, 'time'>
  ): void {
    this.update(origin, false)
    this.update(destination, true)
  }

  update(loc: Omit<NavigationLocation, 'time'>, isJumpLanding: boolean): void {
    const entry: NavigationLocation = { ...loc, time: this.now() }
    const cur = this.current
    if (!cur) {
      this.entries = [entry]
      this.index = 0
      return
    }
    const switched = normalizeDebugPathKey(cur.filePath) !== normalizeDebugPathKey(loc.filePath)
    if (!switched && (!isJumpLanding || cur.line === loc.line)) {
      this.entries[this.index] = entry
      return
    }
    this.entries = this.entries.slice(0, this.index + 1)
    const prev = this.entries[this.index - 1]
    if (prev && samePlace(prev, cur)) {
      this.entries.splice(this.index - 1, 1)
    }
    this.entries.push(entry)
    if (this.entries.length > MAX_ENTRIES) {
      this.entries.splice(0, this.entries.length - MAX_ENTRIES)
    }
    this.index = this.entries.length - 1
  }

  back(): NavigationLocation | null {
    if (!this.canGoBack()) {
      return null
    }
    this.index -= 1
    return this.current
  }

  forward(): NavigationLocation | null {
    if (!this.canGoForward()) {
      return null
    }
    this.index += 1
    return this.current
  }

  clear(): void {
    this.entries = []
    this.index = -1
  }
}
