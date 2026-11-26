import type { Terminal } from '@xterm/xterm'
import { readTerminalCursorLineContext } from '../../../../../shared/terminal/input/terminal-cursor-line-context'
import { readTerminalComposerTypedText } from '../../../../../shared/terminal/input/terminal-composer-draft'

type DraftReadCache = { revision: number; key: string; value: string | null | undefined }

const revisions = new WeakMap<Terminal, { value: number }>()
const cache = new WeakMap<Terminal, DraftReadCache>()

function revisionOf(terminal: Terminal): number {
  let revision = revisions.get(terminal)
  if (!revision) {
    const counter = { value: 0 }
    revision = counter
    revisions.set(terminal, counter)
    // Lives as long as the terminal; one increment per parsed write or resize (reflow without output).
    const bump = (): void => {
      counter.value += 1
    }
    terminal.onWriteParsed(bump)
    terminal.onResize(bump)
  }
  return revision.value
}

/** The user's text in the agent's input line; re-projects the screen only after new output. */
export function readTerminalComposerDraft(terminal: Terminal): string | null {
  const revision = revisionOf(terminal)
  const buffer = terminal.buffer.active
  // Buffer length catches terminal.clear(), which parses no output.
  // The cursor row's text covers output parsed before onWriteParsed fires for its frame.
  const cursorRow = buffer.getLine(buffer.baseY + buffer.cursorY)?.translateToString(true) ?? ''
  const key = `${buffer.type}:${buffer.length}:${buffer.baseY}:${buffer.cursorY}:${buffer.cursorX}:${cursorRow}`
  const cached = cache.get(terminal)
  if (cached && cached.revision === revision && cached.key === key) {
    return cached.value ?? null
  }
  const value = readTerminalComposerTypedText(
    readTerminalCursorLineContext(terminal, terminal.rows)
  )
  cache.set(terminal, { revision, key, value })
  return value
}
