import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Terminal } from '@xterm/headless'
import { PtyStartupIngress } from '../../../../../shared/terminal/pty/ingress/pty-startup-ingress'
import { installTerminalCapabilityReplyHandlers } from './terminal-capability-replies'
import { createIpcPtyTransport } from '../pty-transport/ipc/pty-transport'
import type { PtyTransport } from '../pty-transport/pty-transport-types'

// Guard agent startup color replies against cooked-mode echo leaks; plain tabs and agent ingress must deliver replies without rendering them.

// opencode/OpenTUI's unconditional startup burst (BEL-terminated, not ST).
const OPENCODE_STARTUP_QUERY_BURST = '\x1b]10;?\x07\x1b]11;?\x07\x1b]4;0;?\x07'
// Orca's One Dark terminal theme — the values that appear in the leaked text.
const ORCA_TERMINAL_THEME = { foreground: '#ffffff', background: '#282c34' }
const OSC10_REPLY = '\x1b]10;rgb:ffff/ffff/ffff\x1b\\'
const OSC11_REPLY = '\x1b]11;rgb:2828/2c2c/3434\x1b\\'
const LEAKED_COLOR_REPLY_TEXT = /\d\d;rgb:[0-9a-f]{4}\//

const PTY_ID = 'pty-12112'
let dispatchPtyData: (payload: { id: string; data: string }) => void = () => {}

/** Model measured readline echo: unbound ESC ]/ST are swallowed while the reply payload renders as literal text. */
function readlineEchoOf(reply: string): string {
  return reply.replaceAll('\x1b]', '\x07').replaceAll('\x1b\\', '')
}

type StartupTty = {
  /** A writer (main ingress or renderer) pushes bytes at the PTY master. */
  writeToPty: (data: string) => void
  /** Bytes the querying program actually read. */
  programInput: () => string
  onPtyOutput: (sink: (data: string) => void) => void
  emitStartupBurst: () => void
}

/** Model cooked tty during startup callback and raw tty immediately after; both arms share the same echo timing. */
function createStartupTty(): StartupTty {
  let raw = false
  let received = ''
  let sink: (data: string) => void = () => {}
  return {
    writeToPty: (data) => {
      if (raw) {
        received += data
        return
      }
      // ECHO copies master writes without consuming slave input; TCSANOW/TCSADRAIN preserve delivery, while TCSAFLUSH discards it.
      received += data
      sink(readlineEchoOf(data))
    },
    programInput: () => received,
    onPtyOutput: (next) => {
      sink = next
    },
    emitStartupBurst: () => {
      sink(OPENCODE_STARTUP_QUERY_BURST)
      // Enter raw mode just after the synchronous startup writer callback.
      queueMicrotask(() => {
        raw = true
      })
    }
  }
}

function stubPtyApi(tty: StartupTty): void {
  vi.stubGlobal('window', {
    api: {
      pty: {
        spawn: vi.fn(async () => ({ id: PTY_ID })),
        write: vi.fn((_id: string, data: string) => tty.writeToPty(data)),
        resize: vi.fn(),
        kill: vi.fn(async () => {}),
        claimViewport: vi.fn(),
        onData: (cb: (payload: { id: string; data: string }) => void) => {
          dispatchPtyData = cb
          return () => {}
        },
        onReplay: () => () => {},
        onExit: () => () => {}
      }
    }
  })
}

type RendererPane = {
  transport: PtyTransport
  deliver: (data: string) => void
  renderedText: () => string
  dispose: () => void
}

/** Real xterm + real capability-reply handlers + the real local IPC transport. */
async function createRendererPane(): Promise<RendererPane> {
  const terminal = new Terminal({ cols: 80, rows: 24, allowProposedApi: true })
  terminal.options.theme = { ...ORCA_TERMINAL_THEME }

  const transport = createIpcPtyTransport({ worktreeId: 'wt-1', tabId: 'tab-1', leafId: 'pane:1' })
  await transport.connect({
    url: '',
    cols: 80,
    rows: 24,
    callbacks: { onData: (data) => terminal.write(data) }
  })

  const handlers = installTerminalCapabilityReplyHandlers({
    // SAFETY: headless xterm supplies the parser and event members used by capability replies.
    terminal: terminal as never,
    parser: terminal.parser,
    // Matches pty-connection.ts: replies go out via sendInputImmediate.
    sendInput: (data) => transport.sendInputImmediate(data),
    isReplaying: () => false
  })

  return {
    transport,
    deliver: (data) => dispatchPtyData({ id: PTY_ID, data }),
    renderedText: () => {
      const lines: string[] = []
      for (let row = 0; row < terminal.rows; row += 1) {
        lines.push(terminal.buffer.active.getLine(row)?.translateToString(true) ?? '')
      }
      return lines.join('\n').trim()
    },
    dispose: () => {
      handlers.dispose()
      terminal.dispose()
    }
  }
}

async function settleUntil(condition: () => boolean, timeoutMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition() && Date.now() < deadline) {
    await vi.advanceTimersByTimeAsync(1)
  }
  expect(condition()).toBe(true)
}

describe('#12112 opencode startup OSC 10/11 replies on the local path', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('plain terminal tab consumes the replies and renders nothing', async () => {
    const tty = createStartupTty()
    stubPtyApi(tty)
    const pane = await createRendererPane()
    // Plain tabs have no main startup ingress; xterm alone answers their probes.
    tty.onPtyOutput(pane.deliver)

    try {
      tty.emitStartupBurst()
      await settleUntil(() => tty.programInput().includes(OSC11_REPLY))

      expect(pane.renderedText()).not.toMatch(LEAKED_COLOR_REPLY_TEXT)
      expect(tty.programInput()).toContain(OSC10_REPLY)
      expect(tty.programInput()).toContain(OSC11_REPLY)
    } finally {
      pane.dispose()
    }
  })

  it('agent pane consumes the replies and renders nothing', async () => {
    const tty = createStartupTty()
    stubPtyApi(tty)
    const pane = await createRendererPane()

    // TUI agent launches arm main startup ingress.
    const ingress = new PtyStartupIngress({
      intent: { colors: ORCA_TERMINAL_THEME, deadlineMs: 5_000 },
      ownerBackend: 'posix-pty',
      write: (data) => tty.writeToPty(data),
      onEmission: (emission) => pane.deliver(emission.data)
    })
    tty.onPtyOutput((data) => ingress.accept(data))

    try {
      tty.emitStartupBurst()
      await settleUntil(() => tty.programInput().includes(OSC11_REPLY))

      expect(pane.renderedText()).not.toMatch(LEAKED_COLOR_REPLY_TEXT)
      expect(tty.programInput()).toContain(OSC10_REPLY)
      expect(tty.programInput()).toContain(OSC11_REPLY)
    } finally {
      ingress.drainAndClose()
      pane.dispose()
    }
  })
})
