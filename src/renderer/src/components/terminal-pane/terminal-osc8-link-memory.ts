import type { IDisposable, ILink, ILinkProvider, IMarker, Terminal } from '@xterm/xterm'

/**
 * Remembers OSC 8 hyperlink targets so they survive a TUI repaint.
 *
 * xterm binds each OSC 8 entry to a line marker and drops it when the line is
 * erased. Revealing a hidden pane replays the output queued while it was
 * hidden, and those frames erase the rows they repaint — so a hyperlink the TUI
 * does not re-emit loses its `urlId`, and with it the underline, hover and
 * Cmd+click. Measured: the entry survives the whole time the pane is hidden,
 * dies ~15ms after it becomes visible, and is never re-registered.
 *
 * Plain-text URLs are unaffected because Orca re-derives those from the buffer
 * text (terminal-url-link-hit-testing). An OSC 8 target exists only in the
 * escape sequence, so the only way to recover it is to have kept it.
 *
 * Two lookups, because a TUI moves its own output: the row lookup is exact and
 * handles links that stay put, while the text lookup finds a repainted chip
 * (Claude Code's `[Image #1]`) after its live region shifted to another row.
 * The text lookup can offer a link on a row that only happens to contain the
 * same anchor text — accepted deliberately, since without it a moving chip is
 * permanently dead.
 */

const MAX_REMEMBERED_LINKS = 128
const MAX_REMEMBERED_TEXT_TARGETS = 128
/** Below this, anchor text is too generic to re-offer by content alone. */
const MIN_TEXT_TARGET_LENGTH = 3

export type Osc8LinkSpan = {
  uri: string
  /** Zero-based, half-open [startX, endX) columns the anchor text occupies. */
  startX: number
  endX: number
}

export type TerminalOsc8LinkMemory = IDisposable & {
  linksForRow(absoluteRow: number): Osc8LinkSpan[]
  size(): number
}

type RememberedOsc8Link = Osc8LinkSpan & {
  /** Anchor text when recorded; a repainted row must not serve a stale target. */
  text: string
  marker: IMarker
}

type PendingOsc8Open = {
  uri: string
  startX: number
  absoluteRow: number
}

function readRowText(
  terminal: Terminal,
  absoluteRow: number,
  startX: number,
  endX: number
): string | null {
  const line = terminal.buffer.active.getLine(absoluteRow)
  return line ? line.translateToString(false, startX, endX) : null
}

export function installTerminalOsc8LinkMemory(terminal: Terminal): TerminalOsc8LinkMemory {
  const remembered: RememberedOsc8Link[] = []
  const textTargets = new Map<string, string>()
  let pending: PendingOsc8Open | null = null

  const absoluteCursorRow = (): number =>
    terminal.buffer.active.baseY + terminal.buffer.active.cursorY

  const commit = (): void => {
    const open = pending
    pending = null
    if (!open) {
      return
    }
    const endX = terminal.buffer.active.cursorX
    // Why: a link that soft-wrapped spans rows a single range can't describe.
    if (absoluteCursorRow() !== open.absoluteRow || endX <= open.startX) {
      return
    }
    const text = readRowText(terminal, open.absoluteRow, open.startX, endX)
    if (text === null) {
      return
    }
    const marker = terminal.registerMarker(0)
    if (marker) {
      remembered.push({ uri: open.uri, startX: open.startX, endX, text, marker })
      while (remembered.length > MAX_REMEMBERED_LINKS) {
        remembered.shift()?.marker.dispose()
      }
    }
    if (text.trim().length >= MIN_TEXT_TARGET_LENGTH) {
      // Why: re-inserting moves the key to the end, so the cap evicts by age
      // and a re-used anchor keeps its newest target.
      textTargets.delete(text)
      textTargets.set(text, open.uri)
      while (textTargets.size > MAX_REMEMBERED_TEXT_TARGETS) {
        const oldest = textTargets.keys().next().value
        if (oldest === undefined) {
          break
        }
        textTargets.delete(oldest)
      }
    }
  }

  // Why: returning false lets xterm's built-in OSC 8 handler still run, so this
  // observes hyperlinks without taking over rendering or registration.
  const handlerDisposable = terminal.parser.registerOscHandler(8, (payload: string): boolean => {
    const separator = payload.indexOf(';')
    const uri = separator === -1 ? '' : payload.slice(separator + 1)
    if (uri) {
      pending = { uri, startX: terminal.buffer.active.cursorX, absoluteRow: absoluteCursorRow() }
      return false
    }
    commit()
    return false
  })

  const rowLinks = (absoluteRow: number): Osc8LinkSpan[] => {
    const matches: Osc8LinkSpan[] = []
    for (let index = remembered.length - 1; index >= 0; index--) {
      const entry = remembered[index]
      if (entry.marker.isDisposed) {
        remembered.splice(index, 1)
        continue
      }
      if (entry.marker.line !== absoluteRow) {
        continue
      }
      if (readRowText(terminal, absoluteRow, entry.startX, entry.endX) !== entry.text) {
        continue
      }
      matches.push({ uri: entry.uri, startX: entry.startX, endX: entry.endX })
    }
    return matches
  }

  const textLinks = (absoluteRow: number): Osc8LinkSpan[] => {
    const line = terminal.buffer.active.getLine(absoluteRow)
    if (!line) {
      return []
    }
    const rowText = line.translateToString(false)
    const matches: Osc8LinkSpan[] = []
    for (const [text, uri] of textTargets) {
      let from = 0
      while (from <= rowText.length - text.length) {
        const at = rowText.indexOf(text, from)
        if (at === -1) {
          break
        }
        from = at + text.length
        // Why: string offsets only equal columns when no wide or combining cell
        // shifted the row; re-reading the span proves the mapping before use.
        if (readRowText(terminal, absoluteRow, at, at + text.length) === text) {
          matches.push({ uri, startX: at, endX: at + text.length })
        }
      }
    }
    return matches
  }

  return {
    linksForRow: (absoluteRow: number): Osc8LinkSpan[] => {
      const exact = rowLinks(absoluteRow)
      return exact.length > 0 ? exact : textLinks(absoluteRow)
    },
    size: () => remembered.length,
    dispose: () => {
      handlerDisposable.dispose()
      for (const entry of remembered) {
        entry.marker.dispose()
      }
      remembered.length = 0
      textTargets.clear()
      pending = null
    }
  }
}

type RememberedOsc8LinkProviderDeps = {
  getMemory: () => TerminalOsc8LinkMemory | null
  linkTooltip: HTMLElement
  openLinkHint: string
  activate: (uri: string, event: MouseEvent | undefined) => void
}

export function createRememberedOsc8LinkProvider(
  deps: RememberedOsc8LinkProviderDeps
): ILinkProvider {
  return {
    provideLinks: (bufferLineNumber, callback) => {
      const memory = deps.getMemory()
      if (!memory) {
        callback(undefined)
        return
      }
      // Why: xterm hands providers 1-based buffer rows; markers track 0-based.
      const absoluteRow = bufferLineNumber - 1
      const links = memory.linksForRow(absoluteRow).map(
        (span): ILink => ({
          range: {
            start: { x: span.startX + 1, y: bufferLineNumber },
            end: { x: span.endX, y: bufferLineNumber }
          },
          text: span.uri,
          activate: (event) => deps.activate(span.uri, event as MouseEvent | undefined),
          hover: () => {
            deps.linkTooltip.textContent = `${span.uri} (${deps.openLinkHint})`
            deps.linkTooltip.style.display = ''
          },
          leave: () => {
            deps.linkTooltip.style.display = 'none'
          }
        })
      )
      callback(links.length > 0 ? links : undefined)
    }
  }
}
