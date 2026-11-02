// One contract, two sources: each case runs through the renderer's real producer entry, once
// against a host that runs the generated-input operation itself (the real method and runtime)
// and once against an older host (the client-side legacy source). Only facts are stood in
// (screen, process, streamed bytes, the transport); admission is never mocked.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  finalReplayFrame,
  readRuntimeFixture
} from '../../../main/runtime/agent-transcript-replay-test-harness'
import { createAgentPromptSubmissionRuntime } from '../../../main/runtime/agent-prompt-submission-runtime-test-fixture'
import { eraseRpcMethods, type RpcContext, type RpcMethod } from '../../../main/runtime/rpc/core'
import { GENERATED_INPUT_METHODS } from '../../../main/runtime/rpc/methods/generated-input'
import type { OrcaRuntimeService } from '../../../main/runtime/orca-runtime'
import { toRemoteRuntimePtyId } from '../../../shared/remote-runtime/remote-runtime-pty-id'
import type { RuledScreen } from '../../../shared/screen-input-veto'
import type { TuiAgent } from '../../../shared/tui-agent'
import type * as RuntimeTerminalStreamModule from '@/runtime/runtime-terminal-stream'
import type * as AgentInputDialogModule from '../../../shared/agent-input-dialog'

type Facts = {
  capable: boolean
  /** The client's mounted grid (legacy) and the host's grid; null = none. */
  grid: RuledScreen | null
  /** What an older host's screen read answers: its screen, or only a stream. */
  hostReadsScreen: boolean
  process: string | null
  pasteMode: boolean
  observers: ((data: string) => void)[]
  /** What the terminal already showed before this send: a host's PTY output, an older host's
   *  stream replay on subscription. */
  backlog: string
  /** The text an older host's stream-backed read answers (its recent output), if any. */
  streamTail: string[]
  writes: string[]
  runtime: OrcaRuntimeService | null
  handle: string
  holdProcessRead: Promise<void> | null
  /** Another process takes the terminal once the producer's own first inspection has answered. */
  processAfterInspect: string | null
  /** Runs after each write the terminal takes (a dialog opening between chunks). */
  afterWrite: ((count: number) => void) | null
}
const f = vi.hoisted((): Facts => ({
  capable: true,
  grid: null,
  hostReadsScreen: false,
  process: null,
  pasteMode: false,
  observers: [],
  backlog: '',
  streamTail: [],
  writes: [],
  runtime: null,
  handle: '',
  holdProcessRead: null,
  processAfterInspect: null,
  afterWrite: null
}))

vi.mock('../../../main/git/worktree', () => {
  const rows = [
    { path: '/tmp/worktree-a', head: 'abc', branch: 'b', isBare: false, isMainWorktree: false }
  ]
  return {
    listWorktrees: vi.fn().mockResolvedValue(rows),
    listWorktreesStrict: vi.fn().mockResolvedValue(rows)
  }
})
vi.mock('@/store', () => ({ useAppStore: { getState: () => ({}), subscribe: () => () => {} } }))
vi.mock('./launch-agent-paste-timeout-notice', () => ({ showGeneratedInputNotice: vi.fn() }))
vi.mock('@/components/terminal-pane/pty-buffer-serializer', () => ({
  readPtyInputScreen: async () => f.grid,
  readPtyBracketedPasteMode: () => f.pasteMode
}))
vi.mock('@/runtime/runtime-terminal-stream', async (importOriginal) => ({
  ...(await importOriginal<typeof RuntimeTerminalStreamModule>()),
  subscribeToRuntimeTerminalData: async (
    _ptyId: string,
    _client: string,
    observe: (data: string) => void
  ) => {
    f.observers.push(observe)
    if (f.backlog) {
      observe(f.backlog)
    }
    return () => {
      f.observers = f.observers.filter((entry) => entry !== observe)
    }
  }
}))
vi.mock('@/runtime/runtime-terminal-inspection', () => ({
  inspectRuntimeTerminalProcess: async () => {
    await f.holdProcessRead
    const foreground = f.process
    if (f.processAfterInspect) {
      f.process = f.processAfterInspect
      f.processAfterInspect = null
    }
    return { foregroundProcess: foreground, hasChildProcesses: false }
  }
}))
vi.mock('@/runtime/runtime-terminal-verified-input', () => ({
  sendRuntimePtyInputVerified: async (_ptyId: string, data: string) => {
    f.writes.push(data)
    f.afterWrite?.(f.writes.length)
    return true
  }
}))
// Counts how often an operation normalizes the text it typed (once, however many frames).
vi.mock('../../../shared/agent-input-dialog', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentInputDialogModule>()
  return { ...actual, prepareTypedText: vi.fn(actual.prepareTypedText) }
})
vi.mock('@/runtime/runtime-rpc-client', () => ({
  runtimeEnvironmentSupportsCapability: async () => f.capable,
  callRuntimeRpc: async (
    _target: unknown,
    method: string,
    params: Record<string, unknown>,
    options?: { signal?: AbortSignal }
  ) => {
    if (method === 'terminal.sendGeneratedInput') {
      const send = eraseRpcMethods(GENERATED_INPUT_METHODS).find(
        (entry): entry is RpcMethod =>
          entry.name === 'terminal.sendGeneratedInput' && !('stream' in entry)
      )!
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the method reads only the runtime and connection id.
      const context = {
        runtime: f.runtime,
        connectionId: 'contract',
        // The caller's abort reaches the host's request context, as the transport delivers it.
        signal: options?.signal
      } as unknown as RpcContext
      return await send.handler(send.params ? send.params.parse(params) : params, context)
    }
    if (method === 'terminal.read') {
      if (!f.hostReadsScreen || !f.grid) {
        return { terminal: { tail: f.streamTail, source: 'stream' } }
      }
      return { terminal: { tail: f.grid.lines, source: 'screen' } }
    }
    if (method === 'terminal.agentStatus') {
      return { agentStatus: { handle: f.handle, isRunningAgent: true, status: null } }
    }
    throw new Error(`unexpected ${method}`)
  }
}))

const { deliverGeneratedPaste, pasteDraftToAgentPtyWhenReady, submitPromptToAgentPty } =
  await import('./agent-paste-draft')
const { sendPromptWithGuardedPasteAndEnter } = await import('./active-agent-note-send-delivery')
const { sendFollowupPromptWhenAgentReady } = await import('./agent-followup-delivery')
const { prepareTypedText } = await import('../../../shared/agent-input-dialog')

const DIALOG = [
  'Bypass Permissions',
  '❯ 1. No, exit',
  '  2. Yes, I accept',
  'Enter to confirm · Esc to cancel'
]

async function setUp(agent: TuiAgent, capable: boolean): Promise<string> {
  f.capable = capable
  f.grid = null
  f.hostReadsScreen = false
  f.process = null
  f.pasteMode = false
  f.observers = []
  f.backlog = ''
  f.streamTail = []
  f.writes = []
  f.holdProcessRead = null
  f.processAfterInspect = null
  f.afterWrite = null
  const { runtime, handle, writes } = await createAgentPromptSubmissionRuntime(() => {}, agent)
  f.runtime = runtime
  f.handle = handle
  f.writes = writes
  vi.spyOn(runtime, 'getTerminalSize').mockReturnValue({ cols: 120, rows: 40 })
  // The host's facts follow the same stand-ins as the older host's.
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: reaches the host's protected fact reads on OrcaRuntimeService to stand in the same facts.
  const host = runtime as unknown as {
    readGeneratedInputScreen: () => Promise<unknown>
    readGeneratedInputProcess: () => Promise<unknown>
  }
  const realScreen = host.readGeneratedInputScreen.bind(runtime)
  vi.spyOn(host, 'readGeneratedInputScreen').mockImplementation(async () =>
    f.grid ? f.grid : capable ? await realScreen() : 'unknown'
  )
  vi.spyOn(host, 'readGeneratedInputProcess').mockImplementation(async () => {
    await f.holdProcessRead
    return f.process
      ? { known: true, foreground: f.process, hasChildProcesses: false }
      : { known: false }
  })
  return toRemoteRuntimePtyId(handle, 'env')
}

/** Streamed bytes reach whichever source is observing: the host's PTY or the older host's stream. */
function stream(data: string): void {
  f.runtime?.onPtyData('pty-prompt', data, Date.now())
  for (const observe of f.observers.slice()) {
    observe(data)
  }
}

async function grid(fixture: string, alternateScreen = false): Promise<RuledScreen> {
  vi.useRealTimers()
  const { ruledScreenLines } = await finalReplayFrame(fixture, 120, 40)
  vi.useFakeTimers()
  return { lines: [...ruledScreenLines], alternateScreen }
}

describe.each([
  ['a host that runs the operation', true],
  ['an older host (legacy source)', false]
] as const)('generated input contract, %s', (_label, capable) => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(100_000)
    vi.stubGlobal('window', globalThis)
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  // H1: an idle structural composer seen only on the current grid, with its startup bytes gone.
  it.each([
    ['codex', 'codex-0157-plain-ready', 'codex', false],
    ['opencode2', 'opencode-2-0-21-timed-cold-standalone', 'opencode', true]
  ] as const)(
    'starts %s from its recorded idle grid with no startup replay',
    async (agent, fixture, process, alt) => {
      const ptyId = await setUp(agent, capable)
      f.grid = await grid(fixture, alt)
      f.process = process
      f.pasteMode = true
      stream(alt ? '\x1b[?1049h\x1b[?2004h' : '\x1b[?2004h')
      const result = pasteDraftToAgentPtyWhenReady({
        ptyId,
        content: 'go',
        agent,
        submit: true,
        forcePaste: true,
        timeoutMs: 6000
      })
      await vi.advanceTimersByTimeAsync(6000)
      await expect(result).resolves.toBe(true)
      expect(f.writes.filter((data) => data.includes('go'))).toHaveLength(1)
      expect(f.writes.at(-1)).toBe('\r')
    }
  )

  // H2: nothing observable at all (only an older host can leave a client blind); the decided blind
  // policy delivers as main did, before the deadline.
  it.runIf(!capable)(
    'delivers a startup prompt to a blind, unmounted Claude pane before its deadline',
    async () => {
      const ptyId = await setUp('claude', capable)
      f.process = 'claude'
      const result = pasteDraftToAgentPtyWhenReady({
        ptyId,
        content: 'go',
        agent: 'claude',
        submit: true,
        forcePaste: true,
        timeoutMs: 3000
      })
      await vi.advanceTimersByTimeAsync(2000)
      await expect(result).resolves.toBe(true)
      expect(f.writes.at(-1)).toBe('\r')
    }
  )

  // J2: a short budget still delivers blind; the blind policy does not wait out a quiet window.
  it.runIf(!capable)('delivers blind within a 1,000 ms budget', async () => {
    const ptyId = await setUp('claude', capable)
    f.process = 'claude'
    const result = pasteDraftToAgentPtyWhenReady({
      ptyId,
      content: 'go',
      agent: 'claude',
      submit: true,
      forcePaste: true,
      timeoutMs: 1000
    })
    await vi.advanceTimersByTimeAsync(1000)
    await expect(result).resolves.toBe(true)
    expect(f.writes.filter((data) => data.includes('go'))).toHaveLength(1)
  })

  // H3: a dialog streamed to the observer refuses a running send, on time, with no later write.
  it.each(['cline-3-0-66-permission', 'claude-dialog-trust-workspace'])(
    'refuses a reused session showing %s through its stream, on time, with no later write',
    async (fixture) => {
      const agent = fixture.startsWith('cline') ? 'cline' : 'claude'
      const ptyId = await setUp(agent, capable)
      f.backlog = readRuntimeFixture(fixture)
      f.runtime?.onPtyData('pty-prompt', f.backlog, Date.now())
      const result = submitPromptToAgentPty({ tabId: 't', ptyId, content: 'go', agent })
      await vi.advanceTimersByTimeAsync(60_000)
      await expect(result).resolves.toBe('not-sent')
      await vi.advanceTimersByTimeAsync(10_000)
      expect(f.writes).toEqual([])
    }
  )

  // H5: notes take the same operation; both recorded dialogs keep their keys.
  it.each(['cline-3-0-66-permission', 'antigravity-dialog-model-picker'])(
    'never answers %s with notes',
    async (fixture) => {
      const agent = fixture.startsWith('cline') ? 'cline' : 'antigravity'
      await setUp(agent, capable)
      f.grid = await grid(fixture)
      f.hostReadsScreen = true
      const sent = sendPromptWithGuardedPasteAndEnter(
        { kind: 'environment', environmentId: 'env' },
        f.handle,
        'notes',
        { allowLegacyFallback: false }
      )
      await vi.advanceTimersByTimeAsync(61_000)
      await expect(sent).resolves.not.toEqual({ status: 'sent' })
      expect(f.writes).toEqual([])
    }
  )

  it('withholds Enter when a dialog opens between the text and Enter', async () => {
    const ptyId = await setUp('claude', capable)
    f.grid = { lines: ['❯ '], alternateScreen: false }
    f.process = 'claude'
    f.pasteMode = true
    stream('\x1b[?2004h\x1b[?2031h❯ ')
    const result = submitPromptToAgentPty({ tabId: 't', ptyId, content: 'go', agent: 'claude' })
    await vi.waitFor(() => expect(f.writes).toHaveLength(1))
    f.grid = { lines: DIALOG, alternateScreen: false }
    await vi.advanceTimersByTimeAsync(60_000)
    await expect(result).resolves.toBe('unconfirmed')
    expect(f.writes.filter((data) => data === '\r')).toEqual([])
  })

  // H4: an evidence read near the deadline: the result is on time and nothing is written after.
  it('settles on time when its final read is still pending at the deadline, then writes nothing', async () => {
    const ptyId = await setUp('claude', capable)
    f.grid = { lines: ['❯ '], alternateScreen: false }
    f.process = 'claude'
    let release = (): void => {}
    f.holdProcessRead = new Promise<void>((resolve) => {
      release = resolve
    })
    const result = pasteDraftToAgentPtyWhenReady({
      ptyId,
      content: 'go',
      agent: 'claude',
      submit: true,
      forcePaste: true,
      intent: 'running',
      timeoutMs: 3000
    })
    await vi.advanceTimersByTimeAsync(3001)
    await expect(result).resolves.toBe(false)
    release()
    await vi.advanceTimersByTimeAsync(5000)
    expect(f.writes).toEqual([])
  })

  // J5: a recorded dialog streamed whole, and cut inside every escape sequence, keeps its keys at
  // startup, where a dialog-free tail alone would admit.
  it.each(['whole', 'cut inside every escape sequence'])(
    'never types into the recorded Claude trust dialog streamed %s',
    async (cut) => {
      const ptyId = await setUp('claude', capable)
      f.process = 'claude'
      const recorded = readRuntimeFixture('claude-dialog-trust-workspace')
      // Earlier dialog-free output: the send is not blind, so only the dialog can withhold it.
      f.backlog = 'Claude Code starting\r\n'
      f.streamTail = ['Claude Code starting']
      f.runtime?.onPtyData('pty-prompt', f.backlog, Date.now())
      const result = pasteDraftToAgentPtyWhenReady({
        ptyId,
        content: 'go',
        agent: 'claude',
        submit: true,
        forcePaste: true,
        timeoutMs: 6000
      })
      await vi.advanceTimersByTimeAsync(100)
      if (cut === 'whole') {
        stream(recorded)
      } else {
        let start = 0
        for (let index = recorded.indexOf('\x1b'); index >= 0;) {
          stream(recorded.slice(start, index + 2))
          start = index + 2
          index = recorded.indexOf('\x1b', start)
        }
        stream(recorded.slice(start))
      }
      await vi.advanceTimersByTimeAsync(6000)
      await expect(result).resolves.toBe(false)
      await vi.advanceTimersByTimeAsync(5000)
      expect(f.writes).toEqual([])
    }
  )

  // Control for the case above: the same dialog-free output alone admits through an older host.
  it.runIf(!capable)('delivers at startup when the same earlier output has no dialog', async () => {
    const ptyId = await setUp('claude', capable)
    f.process = 'claude'
    f.backlog = 'Claude Code starting\r\n'
    f.streamTail = ['Claude Code starting']
    const result = pasteDraftToAgentPtyWhenReady({
      ptyId,
      content: 'go',
      agent: 'claude',
      submit: true,
      forcePaste: true,
      timeoutMs: 6000
    })
    await vi.advanceTimersByTimeAsync(6000)
    await expect(result).resolves.toBe(true)
  })

  // J2: the recorded plain Claude 2.1.291 composer with no mode history delivers at startup, as main.
  it('delivers a startup prompt to the recorded plain Claude 2.1.291 composer, as main does', async () => {
    const ptyId = await setUp('claude', capable)
    f.process = 'claude'
    const lines = (await grid('claude-ready-task-wakeup')).lines
    f.streamTail = [...lines]
    f.backlog = lines.join('\r\n')
    f.runtime?.onPtyData('pty-prompt', f.backlog, Date.now())
    const result = pasteDraftToAgentPtyWhenReady({
      ptyId,
      content: 'go',
      agent: 'claude',
      submit: true,
      forcePaste: true,
      timeoutMs: 6000
    })
    await vi.advanceTimersByTimeAsync(6000)
    await expect(result).resolves.toBe(true)
    expect(f.writes.filter((data) => data.includes('go'))).toHaveLength(1)
    expect(f.writes.at(-1)).toBe('\r')
  })

  // CI-4: a follow-up needs its agent still in front at every frame; a shell never gets the text.
  it.each(['before the text', 'between the text and Enter'])(
    'withholds a follow-up when its agent exits %s',
    async (when) => {
      const ptyId = await setUp('claude', capable)
      f.grid = { lines: ['❯ '], alternateScreen: false }
      f.process = when === 'before the text' ? 'zsh' : 'claude'
      f.pasteMode = true
      stream('\x1b[?2004h\x1b[?2031h❯ ')
      const result = pasteDraftToAgentPtyWhenReady({
        ptyId,
        content: 'followup',
        agent: 'claude',
        submit: true,
        forcePaste: true,
        intent: 'running',
        requireConsumer: true,
        timeoutMs: 6000
      })
      if (when !== 'before the text') {
        await vi.waitFor(() => expect(f.writes).toHaveLength(1))
        f.process = 'zsh'
      }
      await vi.advanceTimersByTimeAsync(7000)
      await expect(result).resolves.toBe(false)
      expect(f.writes.filter((data) => data === '\r')).toEqual([])
      expect(f.writes).toHaveLength(when === 'before the text' ? 0 : 1)
    }
  )

  // J8: held keys handed to the operation, then the person answers the dialog themselves: the
  // cancellation reaches the operation, which writes nothing even once the composer is ready.
  it('writes nothing for held keys whose request was cancelled at a dialog, once it is answered', async () => {
    const ptyId = await setUp('claude', capable)
    f.process = 'claude'
    f.grid = { lines: DIALOG, alternateScreen: false }
    f.hostReadsScreen = true
    f.streamTail = DIALOG
    stream(DIALOG.join('\r\n'))
    const takeover = new AbortController()
    const result = deliverGeneratedPaste({
      ptyId,
      content: 'held keys',
      submit: false,
      agent: 'claude',
      inputKind: 'driving',
      intent: 'startup',
      deadline: Date.now() + 60_000,
      signal: takeover.signal
    })
    await vi.advanceTimersByTimeAsync(1000)
    takeover.abort()
    await vi.advanceTimersByTimeAsync(0)
    await expect(result).resolves.toMatch(/^(unconfirmed|not-sent)$/)
    f.grid = { lines: ['❯ '], alternateScreen: false }
    f.streamTail = ['❯ ']
    f.pasteMode = true
    stream('\x1b[2J\x1b[H\x1b[?2004h\x1b[?2031h❯ ')
    await vi.advanceTimersByTimeAsync(61_000)
    expect(f.writes).toEqual([])
  })

  // K3: a follow-up authorized for Aider never reaches Claude, even where the terminal's launch
  // identity still says Claude.
  it('never sends an Aider follow-up to Claude that took the terminal after its first check', async () => {
    const ptyId = await setUp('claude', capable)
    f.grid = { lines: ['❯ '], alternateScreen: false }
    f.pasteMode = true
    f.process = 'aider'
    f.processAfterInspect = 'claude'
    stream('\x1b[?2004h\x1b[?2031h❯ ')
    const result = sendFollowupPromptWhenAgentReady({
      ptyId,
      agent: 'aider',
      expectedProcess: 'aider',
      prompt: 'Aider only followup'
    })
    await vi.advanceTimersByTimeAsync(61_000)
    await expect(result).resolves.toBe(false)
    expect(f.writes).toEqual([])
  })

  // K4: a short budget still leaves a legal moment to start the text, as main delivered.
  it('delivers a startup prompt to the plain Claude 2.1.291 composer within a 1,000 ms budget', async () => {
    const ptyId = await setUp('claude', capable)
    f.process = 'claude'
    const lines = (await grid('claude-ready-task-wakeup')).lines
    f.streamTail = [...lines]
    f.backlog = lines.join('\r\n')
    f.runtime?.onPtyData('pty-prompt', f.backlog, Date.now())
    const result = pasteDraftToAgentPtyWhenReady({
      ptyId,
      content: 'go',
      agent: 'claude',
      submit: true,
      forcePaste: true,
      timeoutMs: 1000
    })
    await vi.advanceTimersByTimeAsync(1100)
    await expect(result).resolves.toBe(true)
    expect(f.writes.filter((data) => data.includes('go'))).toHaveLength(1)
    expect(f.writes.at(-1)).toBe('\r')
  })

  // Controls kept: inline ZCode delivers from its grid; a plain shell never receives the text.
  it('delivers to an inline ZCode composer and refuses a plain shell', async () => {
    const ptyId = await setUp('zcode', capable)
    f.grid = await grid('zcode-composer-ready', true)
    f.process = 'zcode'
    f.pasteMode = true
    stream('\x1b[?1049h\x1b[?2004h')
    const delivered = pasteDraftToAgentPtyWhenReady({
      ptyId,
      content: 'go',
      agent: 'zcode',
      submit: true,
      forcePaste: true,
      timeoutMs: 6000
    })
    await vi.advanceTimersByTimeAsync(5000)
    await expect(delivered).resolves.toBe(true)
    f.writes.length = 0
    f.process = 'zsh'
    const refused = submitPromptToAgentPty({ tabId: 't', ptyId, content: 'go', agent: 'zcode' })
    await vi.advanceTimersByTimeAsync(61_000)
    await expect(refused).resolves.toBe('not-sent')
    expect(f.writes).toEqual([])
  })
})

describe('older-host evidence and work bounds', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(100_000)
    vi.stubGlobal('window', globalThis)
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  // K2: the operation's own stream holds older dialog-free text while the host's current read
  // already returns the recorded trust dialog; the read's dialog still vetoes.
  it('refuses on a dialog in the current read even when its own stream holds older text', async () => {
    const ptyId = await setUp('claude', false)
    f.process = 'claude'
    f.backlog = 'Claude Code starting\r\n'
    f.streamTail = [...(await grid('claude-dialog-trust-workspace')).lines]
    const result = pasteDraftToAgentPtyWhenReady({
      ptyId,
      content: 'generated text',
      agent: 'claude',
      submit: true,
      forcePaste: true,
      timeoutMs: 3000
    })
    await vi.advanceTimersByTimeAsync(3100)
    await expect(result).resolves.toBe(false)
    expect(f.writes).toEqual([])
  })

  // K9: a chunked paste checks every frame against the current screen but normalizes its text once.
  it.each([10, 100])(
    'normalizes the typed text once for a %i-chunk paste, and a dialog between chunks still stops it',
    async (chunks) => {
      const ptyId = await setUp('claude', false)
      f.process = 'claude'
      f.grid = { lines: ['❯ '], alternateScreen: false }
      f.pasteMode = true
      const content = 'x'.repeat(chunks * 16 * 1024)
      vi.mocked(prepareTypedText).mockClear()
      const delivered = pasteDraftToAgentPtyWhenReady({
        ptyId,
        content,
        agent: 'claude',
        submit: false,
        forcePaste: true,
        intent: 'running',
        timeoutMs: 6000
      })
      await vi.advanceTimersByTimeAsync(6000)
      await expect(delivered).resolves.toBe(true)
      expect(f.writes.length).toBeGreaterThan(chunks)
      const normalized = vi
        .mocked(prepareTypedText)
        .mock.calls.reduce((units, [text]) => units + text.length, 0)
      expect(normalized).toBe(content.length)

      // Control: a dialog painted after the third frame refuses every later frame.
      f.writes.length = 0
      f.grid = { lines: ['❯ '], alternateScreen: false }
      f.afterWrite = (count) => {
        if (count === 3) {
          f.grid = { lines: DIALOG, alternateScreen: false }
        }
      }
      const stopped = pasteDraftToAgentPtyWhenReady({
        ptyId,
        content,
        agent: 'claude',
        submit: false,
        forcePaste: true,
        intent: 'running',
        timeoutMs: 6000
      })
      await vi.advanceTimersByTimeAsync(6000)
      await expect(stopped).resolves.toBe(false)
      expect(f.writes).toHaveLength(3)
    }
  )
})
