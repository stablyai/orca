import { afterEach, describe, expect, it, vi } from 'vitest'
import { Terminal } from '@xterm/headless'
import { PtyStartupIngress } from '../../../../shared/pty-startup-ingress'
import { isTuiAgent } from '../../../../shared/tui-agent-config'
import { installTerminalCapabilityReplyHandlers } from './terminal-capability-replies'
import { createIpcPtyTransport } from './pty-transport'
import type { PtyTransport } from './pty-transport-types'

// Regression for #12112: a NEW opencode agent tab on Linux prints the literal
// `10;rgb:ffff/ffff/ffff` / `11;rgb:2828/2c2c/3434` text and opencode never
// initializes, while a plain Ctrl+T tab running the same program is clean.
//
// The divergence is the main-side PtyStartupIngress: only agent panes arm it
// (terminal-startup-color-query-replies.ts), and on `posix-pty` it answers the
// query synchronously inside node-pty's onData — before the querying program
// has finished entering raw mode — with no echo suppression. The suppression
// exists but is gated on `ownerBackend === 'windows-conpty'`
// (pty-startup-ingress.ts:26-29, 247-252), so the cooked-mode echo of Orca's
// own reply is forwarded to the renderer verbatim and rendered as text.

// opencode/OpenTUI's unconditional startup burst (BEL-terminated, not ST).
const OPENCODE_STARTUP_QUERY_BURST = '\x1b]10;?\x07\x1b]11;?\x07\x1b]4;0;?\x07'
// Orca's One Dark terminal theme — the values that appear in the leaked text.
const ORCA_TERMINAL_THEME = { foreground: '#ffffff', background: '#282c34' }
const OSC10_REPLY = '\x1b]10;rgb:ffff/ffff/ffff\x1b\\'
const OSC11_REPLY = '\x1b]11;rgb:2828/2c2c/3434\x1b\\'
const LEAKED_COLOR_REPLY_TEXT = /\d\d;rgb:[0-9a-f]{4}\//

const PTY_ID = 'pty-12112'
let dispatchPtyData: (payload: { id: string; data: string }) => void = () => {}

/**
 * bash/readline echo projection: `\e]` is an unbound binding, so readline eats
 * ESC + `]` and beeps, then self-inserts the rest; the ST is eaten the same way.
 * Verified against a real `bash --norc -i` behind node-pty, and it reproduces
 * the reported string exactly once rendered by xterm.
 */
function readlineEchoOf(reply: string): string {
  return reply.replaceAll('\x1b]', '\x07').replaceAll('\x1b\\', '')
}

type StartupTty = {
  /** A writer (main ingress or renderer) pushes bytes at the PTY master. */
  writeToPty: (data: string) => void
  /** Bytes the querying program actually read in raw mode. */
  programInput: () => string
  onPtyOutput: (sink: (data: string) => void) => void
  emitStartupBurst: () => void
}

/**
 * Models the single fact that decides this bug: the tty is still line
 * disciplined (shell prompt / program mid-`tcsetattr`) during the turn that
 * carries the startup burst, and raw immediately after. A writer answering
 * synchronously inside that turn is echoed; one answering a turn later reaches
 * the program. Both arms of this test share this exact model, so the divergence
 * comes from Orca's code, not from the harness.
 */
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
      sink(readlineEchoOf(data))
    },
    programInput: () => received,
    onPtyOutput: (next) => {
      sink = next
    },
    emitStartupBurst: () => {
      sink(OPENCODE_STARTUP_QUERY_BURST)
      // Why microtask: opencode finishes entering raw mode essentially at once,
      // but not inside its writer's synchronous callback.
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
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
  expect(condition()).toBe(true)
}

describe('#12112 opencode startup OSC 10/11 replies on the local path', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('plain terminal tab consumes the replies and renders nothing', async () => {
    const tty = createStartupTty()
    stubPtyApi(tty)
    const pane = await createRendererPane()
    // A Ctrl+T tab has no launch agent, so shouldReplyToStartupTerminalColorQueries
    // (terminal-startup-color-query-replies.ts) is false, main arms no startup
    // ingress, and the pane's own xterm is the sole responder.
    expect(isTuiAgent(undefined)).toBe(false)
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

    // opencode is a TUI agent, so main arms spawnOptions.startupIngress for this
    // pane and only this pane (pty.ts:4024, terminal-startup-color-query-replies.ts).
    expect(isTuiAgent('opencode')).toBe(true)
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

  it('renders no reply text when the tty echo is coalesced with program output', () => {
    // The reported topology: the agent is launched by writing `opencode\n` into an
    // interactive shell, so bash's echo of Orca's reply shares a read with the shell's
    // own echo and the agent's first frame. It is never at the head of a chunk, and a
    // read carrying no echo at all comes first.
    vi.useFakeTimers()
    const echoLayouts = [
      (replies: readonly string[]) =>
        `opencode\r\n\x1b[2Jloading${replies.map(readlineEchoOf).join('')}\r\n$ `,
      // Both slots answered, but the agent draws between the two echoes.
      (replies: readonly string[]) =>
        replies.map((reply) => `${readlineEchoOf(reply)}FRAME\r\n`).join('')
    ]

    for (const [index, layout] of echoLayouts.entries()) {
      const emitted: string[] = []
      const writes: string[] = []
      const ingress = new PtyStartupIngress({
        intent: { colors: ORCA_TERMINAL_THEME, deadlineMs: 5_000 },
        ownerBackend: 'posix-pty',
        write: (data) => writes.push(data),
        onEmission: (emission) => emitted.push(emission.data)
      })
      ingress.accept(OPENCODE_STARTUP_QUERY_BURST)
      vi.advanceTimersByTime(0)
      expect(writes, `layout ${index}`).toEqual([OSC10_REPLY, OSC11_REPLY])

      ingress.accept(layout(writes))
      ingress.drainAndClose()

      expect(emitted.join(''), `layout ${index}`).not.toMatch(LEAKED_COLOR_REPLY_TEXT)
    }
  })

  it('suppresses its own cooked echo on POSIX and ConPTY', () => {
    // No xterm, no transport: the asymmetry alone, with each backend's observed
    // cooked echo handed straight back the way its line discipline would.
    vi.useFakeTimers()
    const forward = (ownerBackend: 'posix-pty' | 'windows-conpty') => {
      const echoOf =
        ownerBackend === 'windows-conpty'
          ? (reply: string): string => reply.replaceAll('\x1b', '')
          : readlineEchoOf
      const emitted: string[] = []
      const writes: string[] = []
      const ingress = new PtyStartupIngress({
        intent: { colors: ORCA_TERMINAL_THEME, deadlineMs: 5_000 },
        ownerBackend,
        write: (data) => {
          writes.push(data)
          ingress.accept(echoOf(data))
        },
        onEmission: (emission) => emitted.push(emission.data)
      })
      ingress.accept(OPENCODE_STARTUP_QUERY_BURST)
      // Why: the posix write is deferred, so draining first would make this arm
      // assert on a stream where no reply was ever sent.
      vi.advanceTimersByTime(0)
      ingress.drainAndClose()
      return { visible: emitted.join(''), writes }
    }

    for (const ownerBackend of ['windows-conpty', 'posix-pty'] as const) {
      const { visible, writes } = forward(ownerBackend)
      expect(writes, ownerBackend).toEqual([OSC10_REPLY, OSC11_REPLY])
      expect(visible, ownerBackend).not.toMatch(LEAKED_COLOR_REPLY_TEXT)
    }
  })
})
