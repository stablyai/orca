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
  writes: string[]
  runtime: OrcaRuntimeService | null
  handle: string
  holdProcessRead: Promise<void> | null
}
const f = vi.hoisted((): Facts => ({
  capable: true,
  grid: null,
  hostReadsScreen: false,
  process: null,
  pasteMode: false,
  observers: [],
  writes: [],
  runtime: null,
  handle: '',
  holdProcessRead: null
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
    return { foregroundProcess: f.process, hasChildProcesses: false }
  }
}))
vi.mock('@/runtime/runtime-terminal-verified-input', () => ({
  sendRuntimePtyInputVerified: async (_ptyId: string, data: string) => {
    f.writes.push(data)
    return true
  }
}))
vi.mock('@/runtime/runtime-rpc-client', () => ({
  runtimeEnvironmentSupportsCapability: async () => f.capable,
  callRuntimeRpc: async (_target: unknown, method: string, params: Record<string, unknown>) => {
    if (method === 'terminal.sendGeneratedInput') {
      const send = eraseRpcMethods(GENERATED_INPUT_METHODS).find(
        (entry): entry is RpcMethod =>
          entry.name === 'terminal.sendGeneratedInput' && !('stream' in entry)
      )!
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the method reads only the runtime and connection id.
      const context = { runtime: f.runtime, connectionId: 'contract' } as unknown as RpcContext
      return await send.handler(send.params ? send.params.parse(params) : params, context)
    }
    if (method === 'terminal.read') {
      if (!f.hostReadsScreen || !f.grid) {
        return { terminal: { tail: [], source: 'stream' } }
      }
      return { terminal: { tail: f.grid.lines, source: 'screen' } }
    }
    if (method === 'terminal.agentStatus') {
      return { agentStatus: { handle: f.handle, isRunningAgent: true, status: null } }
    }
    throw new Error(`unexpected ${method}`)
  }
}))

const { pasteDraftToAgentPtyWhenReady, submitPromptToAgentPty } =
  await import('./agent-paste-draft')
const { sendPromptWithGuardedPasteAndEnter } = await import('./active-agent-note-send-delivery')

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
  f.writes = []
  f.holdProcessRead = null
  const { runtime, handle, writes } = await createAgentPromptSubmissionRuntime(() => {}, agent)
  f.runtime = runtime
  f.handle = handle
  f.writes = writes
  vi.spyOn(runtime, 'getTerminalSize').mockReturnValue({ cols: 120, rows: 40 })
  // The host's facts follow the same stand-ins as the older host's.
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
      await vi.advanceTimersByTimeAsync(1000)
      await expect(result).resolves.toBe(true)
      expect(f.writes.at(-1)).toBe('\r')
    }
  )

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
