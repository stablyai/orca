// @vitest-environment happy-dom
// Why: #12262/#9803 attribute broken Korean composition to the always-on PTY
// daemon "repainting/capturing terminal state" over an open preedit. This
// replays the real capture/restore choreography (SerializeAddon.serialize ->
// full wipe -> snapshot repaint -> mode reset) against a live composition and
// pins that it reaches neither composition boundary: the helper textarea nor
// the compositionView.
import { SerializeAddon } from '@xterm/addon-serialize'
import { Terminal } from '@xterm/xterm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { POST_REPLAY_LIVE_SNAPSHOT_RESET } from '../../../../shared/terminal-mode-reset-profiles'
import { buildMainModelSnapshotReplayWrites } from './terminal-snapshot-replay-paint'

function openTerminal(): {
  emitted: string[]
  serializeAddon: SerializeAddon
  terminal: Terminal
  textarea: HTMLTextAreaElement
} {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const terminal = new Terminal({ cols: 80, rows: 24 })
  const serializeAddon = new SerializeAddon()
  terminal.loadAddon(serializeAddon)
  terminal.open(container)
  if (!terminal.textarea) {
    throw new Error('xterm helper textarea was not created')
  }
  const emitted: string[] = []
  terminal.onData((data) => emitted.push(data))
  return { emitted, serializeAddon, terminal, textarea: terminal.textarea }
}

function composition(
  textarea: HTMLTextAreaElement,
  type: 'compositionstart' | 'compositionupdate' | 'compositionend',
  data = ''
): void {
  const event = new CompositionEvent(type, { bubbles: true })
  Object.defineProperty(event, 'data', { value: data })
  textarea.dispatchEvent(event)
}

/** Drive one preedit update the way a real IME does: update + beforeinput + value + input. */
function compositionText(textarea: HTMLTextAreaElement, data: string): void {
  textarea.setSelectionRange(0, textarea.value.length)
  composition(textarea, 'compositionupdate', data)
  textarea.dispatchEvent(
    new InputEvent('beforeinput', {
      bubbles: true,
      data,
      inputType: 'insertCompositionText',
      isComposing: true
    })
  )
  textarea.value = data
  textarea.setSelectionRange(data.length, data.length)
  textarea.dispatchEvent(
    new InputEvent('input', {
      bubbles: true,
      data,
      inputType: 'insertCompositionText',
      isComposing: true
    })
  )
}

function writeTerminal(terminal: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => terminal.write(data, resolve))
}

/** xterm defers the compositionend commit through setTimeout(0) to read the settled textarea. */
function nextTask(): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, 0))
}

/** The compositionView xterm renders the visible preedit into. */
function compositionView(): HTMLElement {
  const view = document.querySelector('.composition-view')
  if (!(view instanceof HTMLElement)) {
    throw new Error('compositionView was not created')
  }
  return view
}

type PreeditState = {
  active: boolean
  selectionEnd: number | null
  selectionStart: number | null
  value: string
  viewText: string
}

function readPreedit(textarea: HTMLTextAreaElement): PreeditState {
  const view = compositionView()
  return {
    active: view.classList.contains('active'),
    selectionEnd: textarea.selectionEnd,
    selectionStart: textarea.selectionStart,
    value: textarea.value,
    viewText: view.textContent ?? ''
  }
}

/**
 * The exact renderer half of a daemon snapshot restore, lifted from
 * applyMainBufferSnapshot in pty-connection.ts: resize to snapshot dimensions,
 * paint the ordered replay writes, then the post-replay mode reset.
 */
async function applyDaemonSnapshotRestore(
  terminal: Terminal,
  snapshot: { cols: number; data: string; rows: number }
): Promise<void> {
  if (terminal.cols !== snapshot.cols || terminal.rows !== snapshot.rows) {
    terminal.resize(snapshot.cols, snapshot.rows)
  }
  for (const chunk of buildMainModelSnapshotReplayWrites(snapshot)) {
    await writeTerminal(terminal, chunk)
  }
  await writeTerminal(terminal, POST_REPLAY_LIVE_SNAPSHOT_RESET)
}

describe('daemon snapshot capture/restore vs an open IME preedit', () => {
  beforeEach(() => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      measureText: () => ({ width: 10 })
    } as unknown as CanvasRenderingContext2D)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    document.body.replaceChildren()
  })

  it('serialize capture does not disturb an open preedit', async () => {
    const { serializeAddon, terminal, textarea } = openTerminal()
    await writeTerminal(terminal, 'prompt$ ')

    composition(textarea, 'compositionstart')
    compositionText(textarea, '한')
    const before = readPreedit(textarea)
    expect(before).toMatchObject({ active: true, value: '한' })

    const captured = serializeAddon.serialize({ scrollback: 0 })

    expect(captured).toContain('prompt$ ')
    expect(readPreedit(textarea)).toEqual(before)
  })

  it('the uncommitted preedit is absent from the captured snapshot', async () => {
    const { serializeAddon, terminal, textarea } = openTerminal()
    await writeTerminal(terminal, 'prompt$ ')
    composition(textarea, 'compositionstart')
    compositionText(textarea, '한')

    // Why: the preedit lives in the textarea, never the xterm buffer — so the
    // snapshot cannot carry it, and restoring cannot echo a stale copy back.
    expect(serializeAddon.serialize({ scrollback: 0 })).not.toContain('한')
  })

  it('a full wipe-and-repaint restore mid-composition leaves the preedit intact', async () => {
    const { serializeAddon, terminal, textarea } = openTerminal()
    await writeTerminal(terminal, 'prompt$ ')

    composition(textarea, 'compositionstart')
    compositionText(textarea, '한')
    const before = readPreedit(textarea)

    const snapshot = {
      cols: terminal.cols,
      data: serializeAddon.serialize({ scrollback: 0 }),
      rows: terminal.rows
    }
    await applyDaemonSnapshotRestore(terminal, snapshot)

    // Both boundaries survive: helper textarea and the visible compositionView.
    expect(readPreedit(textarea)).toEqual(before)
  })

  it('a restore that resizes mid-composition leaves the preedit intact', async () => {
    const { serializeAddon, terminal, textarea } = openTerminal()
    await writeTerminal(terminal, 'prompt$ ')

    composition(textarea, 'compositionstart')
    compositionText(textarea, '한')
    const before = readPreedit(textarea)

    await applyDaemonSnapshotRestore(terminal, {
      cols: 100,
      data: serializeAddon.serialize({ scrollback: 0 }),
      rows: 30
    })

    expect(readPreedit(textarea)).toEqual(before)
  })

  it('an alt-screen restore mid-composition leaves the preedit intact', async () => {
    const { terminal, textarea } = openTerminal()
    composition(textarea, 'compositionstart')
    compositionText(textarea, '한')
    const before = readPreedit(textarea)

    for (const chunk of buildMainModelSnapshotReplayWrites({
      alternateScreen: true,
      data: 'alt frame',
      scrollbackAnsi: 'history'
    })) {
      await writeTerminal(terminal, chunk)
    }
    await writeTerminal(terminal, POST_REPLAY_LIVE_SNAPSHOT_RESET)

    expect(readPreedit(textarea)).toEqual(before)
  })

  it('repeated restores during a growing composition never drop or reorder jamo', async () => {
    const { emitted, serializeAddon, terminal, textarea } = openTerminal()
    composition(textarea, 'compositionstart')

    // Why: the reporters describe loss "whenever" the daemon repaints — so
    // interleave a restore between every preedit step, not just once.
    for (const step of ['ㅁ', '무', '문', '문ㅈ', '문제']) {
      compositionText(textarea, step)
      await applyDaemonSnapshotRestore(terminal, {
        cols: terminal.cols,
        data: serializeAddon.serialize({ scrollback: 0 }),
        rows: terminal.rows
      })
      expect(readPreedit(textarea)).toMatchObject({ active: true, value: step })
    }

    composition(textarea, 'compositionend', '문제')
    await nextTask()

    // The PTY boundary #12164 cares about: exactly the committed text, no
    // duplicated or interleaved jamo.
    expect(emitted.join('')).toBe('문제')
  })
})
