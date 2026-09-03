/**
 * Real-fish regression for #9993: Orca must never write `CSI ?997;Nn` into a PTY
 * because fish armed DECSET 2031 around a prompt.
 *
 * fish toggles `?2031h ... ?2031l` in tty_handoff.rs every time it paints a prompt and
 * withdraws before handing the tty to a child, so the arm window is ~1ms — shorter than
 * a renderer IPC hop. Any reply lands after the withdrawal and is read by whatever owns
 * the tty next: it paints as literal `?997;1n` at the prompt, or is swallowed by a child
 * that reads stdin (npx / brew confirm prompts).
 *
 * The assertion is therefore about what a CHILD PROCESS READS, not what renders: a
 * screen-level check passes while the child's stdin is still corrupted.
 *
 * Real production code under test: connectPanePty's live mode-2031 chunk observer. The
 * mock transport writes whatever the renderer sends straight into the real fish PTY, so a
 * reply-on-subscribe reaches the child exactly as it does in the app. DA1/CPR/OSC-10/11
 * probes are answered by the harness because no real xterm is attached here — without
 * them fish stalls ~10s on its DA1 wait and every timing claim becomes meaningless.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type * as React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  fishRequirementViolation,
  resolveFishBinary
} from '../../../../shared/fish-binary-requirement'

// Why a version floor and not just presence: DECSET 2031 arming lives in the Rust
// tty_handoff introduced by the fish 4.0 rewrite. An older fish cannot produce the
// subscribe at all, so the test would pass vacuously instead of guarding anything.
const FISH = resolveFishBinary(4)
const FISH_BIN = FISH.path
const itWithFish = FISH.available ? it : it.skip

const PROMPT_MARK = 'ORCA997> '
const COLOR_SCHEME_REPORT_PREFIX = '\x1b[?997'
const ARM_2031 = '\x1b[?2031h'
const WITHDRAW_2031 = '\x1b[?2031l'
const LEAF_1 = '11111111-1111-4111-8111-111111111111'
const DA1_REPLY = '\x1b[?62;4;6;22c'
const DSR_REPLY = '\x1b[1;1R'
const OSC_10_REPLY = '\x1b]10;rgb:eeee/eeee/eeee\x1b\\'
const OSC_11_REPLY = '\x1b]11;rgb:1e1e/1e1e/1e1e\x1b\\'
const TERMINAL_QUERY_REPLIES: readonly (readonly [string, string])[] = [
  ['\x1b[0c', DA1_REPLY],
  ['\x1b[c', DA1_REPLY],
  ['\x1b[6n', DSR_REPLY],
  ['\x1b]10;?\x07', OSC_10_REPLY],
  ['\x1b]10;?\x1b\\', OSC_10_REPLY],
  ['\x1b]11;?\x07', OSC_11_REPLY],
  ['\x1b]11;?\x1b\\', OSC_11_REPLY]
]
const QUERY_CARRY_LENGTH = Math.max(...TERMINAL_QUERY_REPLIES.map(([query]) => query.length)) - 1

type MutableState = Record<string, unknown>
let mockStoreState: MutableState = {}
let storeSubscribers: ((state: MutableState) => void)[] = []
let transportFactoryQueue: unknown[] = []

vi.mock('@/runtime/sync-runtime-graph', () => ({ scheduleRuntimeGraphSync: vi.fn() }))
vi.mock('./terminal-webgl-atlas-recovery', () => ({
  scheduleImagePasteWebglAtlasRecovery: vi.fn()
}))
vi.mock('@/lib/codex-stale-pane-sweep', () => ({ notifyCodexPaneBoundForStaleSweep: vi.fn() }))
vi.mock('sonner', () => ({ toast: { info: vi.fn() } }))
vi.mock('./cache-timer-seeding', () => ({ shouldSeedCacheTimerOnInitialTitle: vi.fn(() => false) }))
vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => mockStoreState,
    subscribe: (listener: (state: MutableState) => void) => {
      storeSubscribers.push(listener)
      return () => {
        storeSubscribers = storeSubscribers.filter((candidate) => candidate !== listener)
      }
    }
  }
}))
// Why: connectPanePty calls useNotificationDispatch's useCallback outside React.
vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof React>()),
  useCallback: <T>(fn: T): T => fn
}))
vi.mock('./pty-transport', () => ({
  createIpcPtyTransport: vi.fn(() => {
    const next = transportFactoryQueue.shift()
    if (!next) {
      throw new Error('No mock transport queued')
    }
    return next
  })
}))

type ConnectCallbacks = { onData?: (data: string) => void }

/** Mock transport whose renderer→PTY writes land in the real fish master fd. */
function createPtyBackedTransport(write: (data: string) => void): {
  transport: Record<string, unknown>
  sent: string[]
  emit: (data: string) => void
} {
  const sent: string[] = []
  const captured: { current: ((data: string) => void) | null } = { current: null }
  const send = (data: string): boolean => {
    sent.push(data)
    write(data)
    return true
  }
  const transport = {
    attach: vi.fn(),
    connect: vi.fn(async ({ callbacks }: { callbacks?: ConnectCallbacks }) => {
      captured.current = callbacks?.onData ?? null
      return 'fish-pty'
    }),
    disconnect: vi.fn(),
    sendInput: vi.fn(send),
    sendInputImmediate: vi.fn(send),
    sendInputAccepted: vi.fn(async (data: string) => send(data)),
    isConnected: vi.fn(() => true),
    claimViewport: vi.fn(() => true),
    resize: vi.fn(() => true),
    getPtyId: vi.fn(() => 'fish-pty'),
    getConnectionId: vi.fn(() => null)
  }
  return { transport, sent, emit: (data: string) => captured.current?.(data) }
}

function createPane(paneId: number): Record<string, unknown> {
  const activeBuffer = { type: 'normal' as const, viewportY: 0, baseY: 0, cursorY: 0, cursorX: 0 }
  const container = new EventTarget()
  Object.defineProperty(container, 'dataset', { configurable: true, value: {} })
  return {
    id: paneId,
    leafId: LEAF_1,
    stablePaneId: LEAF_1,
    container,
    fitAddon: { fit: vi.fn(), proposeDimensions: vi.fn(() => ({ cols: 120, rows: 30 })) },
    terminal: {
      cols: 120,
      rows: 30,
      element: {},
      buffer: { active: activeBuffer },
      modes: { bracketedPasteMode: false, sendFocusMode: false },
      options: { scrollback: 5_000, theme: { foreground: '#eeeeee', background: '#111111' } },
      write: vi.fn(),
      resize: vi.fn(),
      clear: vi.fn(),
      scrollToBottom: vi.fn(),
      paste: vi.fn(),
      onData: vi.fn(() => ({ dispose: vi.fn() })),
      onResize: vi.fn(() => ({ dispose: vi.fn() })),
      onRender: vi.fn(() => ({ dispose: vi.fn() })),
      onTitleChange: vi.fn(() => ({ dispose: vi.fn() })),
      hasSelection: vi.fn(() => false),
      parser: {
        registerCsiHandler: vi.fn(() => ({ dispose: vi.fn() })),
        registerOscHandler: vi.fn(() => ({ dispose: vi.fn() }))
      }
    }
  }
}

function createDeps(): Record<string, unknown> {
  return {
    tabId: 'tab-1',
    worktreeId: 'wt-1',
    cwd: '/tmp/wt-1',
    startup: null,
    restoredLeafId: null,
    restoredPtyIdByLeafId: {},
    paneTransportsRef: { current: new Map() },
    paneMode2031Ref: { current: new Map<number, boolean>() },
    paneKittyKeyboardModesRef: { current: new Map() },
    paneLastThemeModeRef: { current: new Map<number, 'dark' | 'light'>() },
    replayingPanesRef: { current: new Map() },
    isActiveRef: { current: true },
    isVisibleRef: { current: true },
    onPtyExitRef: { current: vi.fn() },
    onAgentExitedRef: { current: vi.fn() },
    onPtyErrorRef: { current: vi.fn() },
    clearTabPtyId: vi.fn(),
    consumeSuppressedPtyExit: vi.fn(() => false),
    isPtyShutdownPending: vi.fn(() => false),
    updateTabTitle: vi.fn(),
    setRuntimePaneTitle: vi.fn(),
    clearRuntimePaneTitle: vi.fn(),
    updateTabPtyId: vi.fn(),
    markWorktreeUnread: vi.fn(),
    markTerminalTabUnread: vi.fn(),
    markTerminalPaneUnread: vi.fn(),
    clearWorktreeUnread: vi.fn(),
    clearTerminalTabUnread: vi.fn(),
    clearTerminalPaneUnread: vi.fn(),
    dispatchNotification: vi.fn(),
    onShowSessionRestoredBanner: vi.fn(),
    setCacheTimerStartedAt: vi.fn(),
    syncPanePtyLayoutBinding: vi.fn(),
    clearExitedPanePtyLayoutBinding: vi.fn()
  }
}

function createManager(pane: Record<string, unknown>): Record<string, unknown> {
  return {
    setPaneGpuRendering: vi.fn(),
    markPaneHasComplexScriptOutput: vi.fn(),
    rebuildPaneWebgl: vi.fn(),
    hasWebglRenderer: vi.fn(() => false),
    getPanes: vi.fn(() => [pane]),
    closePane: vi.fn(),
    getActivePane: vi.fn(() => pane),
    getNumericIdForLeaf: vi.fn(() => 1),
    setActivePane: vi.fn()
  }
}

const sleep = (msValue: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, msValue))

const countOf = (haystack: string, needle: string): number => haystack.split(needle).length - 1

async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) {
      return true
    }
    await sleep(10)
  }
  return false
}

function createTerminalQueryResponder(write: (reply: string) => void): {
  accept: (chunk: string) => void
  getCarryLength: () => number
} {
  let carry = ''
  return {
    accept: (chunk) => {
      const carriedLength = carry.length
      const scan = carry + chunk
      carry = scan.slice(-QUERY_CARRY_LENGTH)
      for (let at = 0; at < scan.length; at += 1) {
        for (const [query, reply] of TERMINAL_QUERY_REPLIES) {
          if (!scan.startsWith(query, at)) {
            continue
          }
          if (at + query.length > carriedLength) {
            write(reply)
          }
          at += query.length - 1
          break
        }
      }
    },
    getCarryLength: () => carry.length
  }
}

function allChunkPartitions(input: string): string[][] {
  if (input.length === 0) {
    return [[]]
  }
  const partitions: string[][] = []
  for (let end = 1; end <= input.length; end += 1) {
    for (const suffix of allChunkPartitions(input.slice(end))) {
      partitions.push([input.slice(0, end), ...suffix])
    }
  }
  return partitions
}

function collectTerminalQueryReplies(chunks: readonly string[]): string[] {
  const replies: string[] = []
  const responder = createTerminalQueryResponder((reply) => replies.push(reply))
  chunks.forEach(responder.accept)
  return replies
}

describe('terminal query responder', () => {
  it.each([
    ['OSC 10 BEL', '\x1b]10;?\x07', OSC_10_REPLY],
    ['OSC 10 ST', '\x1b]10;?\x1b\\', OSC_10_REPLY],
    ['OSC 11 BEL', '\x1b]11;?\x07', OSC_11_REPLY],
    ['OSC 11 ST', '\x1b]11;?\x1b\\', OSC_11_REPLY]
  ])('answers each complete %s query once across every partition', (_label, query, reply) => {
    for (const chunks of allChunkPartitions(query)) {
      expect(collectTerminalQueryReplies(chunks)).toEqual([reply])
    }
  })

  it.each([
    ['DA1 with omitted parameter', '\x1b[c', DA1_REPLY],
    ['DA1 with zero parameter', '\x1b[0c', DA1_REPLY],
    ['DSR cursor position', '\x1b[6n', DSR_REPLY]
  ])('preserves %s across every partition', (_label, query, reply) => {
    for (const chunks of allChunkPartitions(query)) {
      expect(collectTerminalQueryReplies(chunks)).toEqual([reply])
    }
  })

  it.each([
    ['unterminated OSC 10', '\x1b]10;?'],
    ['unterminated OSC 11 ST', '\x1b]11;?\x1b'],
    ['OSC 10 extra query marker', '\x1b]10;??\x07'],
    ['OSC 11 stacked query', '\x1b]11;?;?\x07'],
    ['OSC 10 malformed body', '\x1b]10;?x\x07'],
    ['OSC 11 malformed ST body', '\x1b]11;?x\x1b\\'],
    ['OSC slot lookalike', '\x1b]110;?\x07']
  ])('rejects %s across every partition', (_label, input) => {
    for (const chunks of allChunkPartitions(input)) {
      expect(collectTerminalQueryReplies(chunks)).toEqual([])
    }
  })

  it('answers concatenated queries once each in source order across every partition', () => {
    const input = '\x1b]10;?\x07\x1b]11;?\x07'
    for (const chunks of allChunkPartitions(input)) {
      expect(collectTerminalQueryReplies(chunks)).toEqual([OSC_10_REPLY, OSC_11_REPLY])
    }
  })

  it('bounds carry while rejecting a long unterminated query lookalike', () => {
    const replies: string[] = []
    const responder = createTerminalQueryResponder((reply) => replies.push(reply))
    let maxCarryLength = 0
    for (const fragment of `\x1b]10;?${'x'.repeat(10_000)}`) {
      responder.accept(fragment)
      maxCarryLength = Math.max(maxCarryLength, responder.getCarryLength())
    }
    for (const fragment of '\x1b]10;?\x07') {
      responder.accept(fragment)
    }

    expect(maxCarryLength).toBe(QUERY_CARRY_LENGTH)
    expect(responder.getCarryLength()).toBeLessThanOrEqual(QUERY_CARRY_LENGTH)
    expect(replies).toEqual([OSC_10_REPLY])
  })
})

describe('fish never receives a color-scheme report it did not query (#9993)', () => {
  let configHome: string | null = null

  // Always runs, so the CI lane cannot report green with the regression below skipped.
  it('has the fish this suite needs when CI requires one', () => {
    expect(fishRequirementViolation(FISH)).toBeNull()
  })

  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    transportFactoryQueue = []
    storeSubscribers = []
    mockStoreState = {
      activeWorktreeId: 'wt-1',
      tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: 'fish-pty' }] },
      ptyIdsByTabId: { 'tab-1': ['fish-pty'] },
      terminalLayoutsByTabId: {
        'tab-1': {
          root: { type: 'leaf', leafId: LEAF_1 },
          activeLeafId: LEAF_1,
          expandedLeafId: null,
          ptyIdsByLeafId: { [LEAF_1]: 'fish-pty' }
        }
      },
      unreadTerminalTabs: {},
      deleteStateByWorktreeId: {},
      worktreesByRepo: { repo1: [{ id: 'wt-1', repoId: 'repo1', path: '/tmp/wt-1' }] },
      runtimeStatusByEnvironmentId: new Map(),
      repos: [{ id: 'repo1', connectionId: null }],
      projects: [],
      sshConnectionStates: new Map(),
      transientClearedAgentStatusConnectionIds: {},
      cacheTimerByKey: {},
      // Dark app mode: a pre-fix reply is `CSI ?997;1n`, the exact payload issue #9993 reports.
      settings: {
        theme: 'dark',
        promptCacheTimerEnabled: true,
        terminalMainSideEffectAuthority: false
      },
      codexRestartNoticeByPtyId: {},
      deferredSshReconnectTargets: [],
      deferredSshSessionIdsByTabId: {},
      removeDeferredSshReconnectTarget: vi.fn(),
      removeDeferredSshSessionId: vi.fn(),
      consumePendingColdRestore: vi.fn(() => null),
      consumePendingSnapshot: vi.fn(() => null),
      runtimePaneTitlesByTabId: {},
      agentStatusByPaneKey: {},
      retainedAgentsByPaneKey: {},
      paneForegroundAgentByPaneKey: {},
      sleepingAgentSessionsByPaneKey: {},
      suppressedPtyExitIds: {},
      agentLaunchConfigByPaneKey: {},
      getAgentLaunchConfigForStatusEntry: vi.fn(),
      getAgentLaunchConfigForStatusMetadata: vi.fn(),
      clearSleepingAgentSession: vi.fn(),
      registerAgentLaunchConfig: vi.fn(),
      clearAgentLaunchConfig: vi.fn(),
      markWorktreeUnread: vi.fn(),
      observeTerminalGitHubPullRequestLink: vi.fn(),
      recordTerminalInput: vi.fn(),
      setAgentStatus: vi.fn(),
      removeAgentStatus: vi.fn(),
      dropAgentStatus: vi.fn(),
      retireAgentPaneAuthority: vi.fn(),
      setPaneForegroundAgent: vi.fn(),
      clearPaneForegroundAgent: vi.fn(),
      markTerminalTabUnread: vi.fn(),
      markTerminalPaneUnread: vi.fn(),
      markAgentCompletionPaneUnread: vi.fn()
    }
    ;(globalThis as unknown as { window: unknown }).window = {
      api: {
        pty: {
          kill: vi.fn(),
          signal: vi.fn(),
          listSessions: vi.fn().mockResolvedValue([]),
          hasPty: vi.fn().mockResolvedValue(true),
          getSize: vi.fn().mockResolvedValue(null),
          reportGeometry: vi.fn(),
          getMainBufferSnapshot: vi.fn().mockResolvedValue(null),
          getForegroundProcess: vi.fn().mockResolvedValue(null),
          inspectProcess: vi.fn().mockResolvedValue(null),
          confirmForegroundProcess: vi.fn().mockResolvedValue(null),
          hasChildProcesses: vi.fn().mockResolvedValue(false),
          write: vi.fn(),
          writeAccepted: vi.fn().mockResolvedValue(true),
          setHiddenRendererPty: vi.fn(),
          setPtyDeliveryInterest: vi.fn(),
          ackColdRestore: vi.fn(),
          onClearBufferRequest: vi.fn(() => vi.fn()),
          onSerializeBufferRequest: vi.fn(() => vi.fn()),
          sendSerializedBuffer: vi.fn(),
          declarePendingPaneSerializer: vi.fn().mockResolvedValue(1),
          settlePaneSerializer: vi.fn().mockResolvedValue(undefined),
          clearPendingPaneSerializer: vi.fn().mockResolvedValue(undefined),
          reportRendererSerializerReady: vi.fn().mockResolvedValue(undefined)
        },
        platform: { get: vi.fn(() => ({ platform: process.platform, osRelease: '' })) },
        notifications: {
          dispatch: vi.fn().mockResolvedValue({ delivered: true }),
          playSound: vi.fn().mockResolvedValue({ played: true })
        },
        runtime: { restoreTerminalFit: vi.fn().mockResolvedValue({ restored: true }) },
        agentStatus: { inferInterrupt: vi.fn().mockResolvedValue(false) }
      },
      dispatchEvent: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    }
    globalThis.requestAnimationFrame = vi.fn((callback: FrameRequestCallback) => {
      callback(0)
      return 1
    })
    globalThis.cancelAnimationFrame = vi.fn()
  })

  afterEach(() => {
    delete (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame
    delete (globalThis as { cancelAnimationFrame?: unknown }).cancelAnimationFrame
    delete (globalThis as { window?: unknown }).window
    if (configHome) {
      rmSync(configHome, { recursive: true, force: true })
      configHome = null
    }
  })

  itWithFish(
    'writes no CSI 997 while fish arms mode 2031 around its prompt, so a child reads clean stdin',
    async () => {
      const { connectPanePty } = await import('./pty-connection')
      const nodePty = await import('node-pty')

      configHome = mkdtempSync(path.join(tmpdir(), 'orca-fish-2031-'))
      mkdirSync(path.join(configHome, 'fish'), { recursive: true })
      // Plain prompt, no user config: fish core toggles DEC 2031 regardless of the prompt.
      writeFileSync(
        path.join(configHome, 'fish/config.fish'),
        [
          'set -g fish_greeting ""',
          `function fish_prompt; printf '${PROMPT_MARK}'; end`,
          'function fish_right_prompt; end',
          ''
        ].join('\n')
      )
      // Echoes the first stdin LINE back escaped, so leaked control bytes are visible on
      // screen. Why a line and not the first chunk: leaked replies carry no newline, so a
      // once('data') child reports them alone whenever they arrive in their own read —
      // which is what the issue's own `sys.stdin.readline()` repro measures.
      const childScript = path.join(configHome, 'read-stdin.mjs')
      writeFileSync(
        childScript,
        "let buffered = ''\n" +
          "process.stdin.on('data', (d) => {\n" +
          "  buffered += d.toString('utf8')\n" +
          "  if (!buffered.includes('\\n')) return\n" +
          "  process.stdout.write('CHILD-READ:' + JSON.stringify(buffered) + '\\n')\n" +
          '  process.exit(0)\n' +
          '})\n' +
          "process.stdout.write('CHILD-READY\\n')\n"
      )

      const term = nodePty.spawn(FISH_BIN as string, ['-l', '-i'], {
        name: 'xterm-256color',
        cols: 120,
        rows: 30,
        cwd: configHome,
        env: {
          PATH: process.env.PATH ?? '/usr/bin:/bin',
          HOME: configHome,
          TERM: 'xterm-256color',
          COLORTERM: 'truecolor',
          LANG: 'en_US.UTF-8',
          XDG_CONFIG_HOME: configHome,
          XDG_DATA_HOME: path.join(configHome, 'data'),
          ORCA_NODE_BIN: process.execPath,
          ORCA_CHILD_SCRIPT: childScript
        }
      })

      let rendered = ''
      const { transport, sent, emit } = createPtyBackedTransport((data) => term.write(data))
      const answerTerminalQueries = createTerminalQueryResponder((reply) => term.write(reply))
      transportFactoryQueue.push(transport)

      // Why answered here: no real xterm is attached, and fish blocks its first prompt ~10s
      // on DA1 and re-probes every prompt. These are harness bytes, never renderer output.
      term.onData((chunk) => {
        rendered += chunk
        // Maximal fragmentation keeps query handling independent of node-pty chunk boundaries.
        for (const fragment of chunk) {
          answerTerminalQueries.accept(fragment)
        }
        emit(chunk)
      })

      let exited = false
      term.onExit(() => {
        exited = true
      })

      try {
        const pane = createPane(1)
        const deps = createDeps()
        const binding = connectPanePty(pane as never, createManager(pane) as never, deps as never)

        expect(await waitUntil(() => rendered.includes(PROMPT_MARK), 15_000)).toBe(true)
        // The arm is the settle signal.
        expect(await waitUntil(() => rendered.includes(ARM_2031), 5_000)).toBe(true)
        // Vacuity guard: the renderer observer must actually have seen the subscribe,
        // otherwise "sent nothing" is trivially true. Checked here and not at the end,
        // because the last decision races between fish's subscribe and its withdrawal.
        const paneMode2031 = (deps as { paneMode2031Ref: { current: Map<number, boolean> } })
          .paneMode2031Ref.current
        expect(await waitUntil(() => paneMode2031.get(1) === true, 5_000)).toBe(true)

        // Type-ahead is the deterministic leak shape: queue the child command while an
        // external command still owns the tty, so fish repaints the prompt (`?2031h`) and
        // consumes the buffered line in the same breath — handoff lands sub-millisecond
        // after the subscribe, inside any reply's flight time.
        term.write('sleep 0.4\r')
        // Withdrawal #1: `sleep` owns the tty now, so the next line is typed ahead.
        expect(await waitUntil(() => countOf(rendered, WITHDRAW_2031) >= 1, 5_000)).toBe(true)
        term.write('"$ORCA_NODE_BIN" "$ORCA_CHILD_SCRIPT"\r')
        // Withdrawal #2: fish re-armed for the prompt and accepted the child command.
        expect(await waitUntil(() => countOf(rendered, WITHDRAW_2031) >= 2, 5_000)).toBe(true)
        // DECSET withdrawal precedes fish's child spawn; the child's marker is the ownership signal.
        expect(await waitUntil(() => rendered.includes('CHILD-READY'), 5_000)).toBe(true)

        const renderedBeforeChildInput = rendered.length
        // Canonical mode buffers this in the tty, so it queues behind anything already
        // written there — including a reply the renderer sent during the handoff.
        term.write('hello\r')
        expect(
          await waitUntil(
            () => rendered.slice(renderedBeforeChildInput).includes('CHILD-READ:'),
            10_000
          )
        ).toBe(true)

        const childRead =
          rendered.slice(renderedBeforeChildInput).match(/CHILD-READ:[^\r\n]*/)?.[0] ?? ''
        // The merge-blocking assertion: the child's STDIN, not the screen. A rendered-output
        // check passes while npx/brew confirm prompts still eat the bytes.
        // Scope note: the harness' own DA1/CPR/OSC-11 answers can still land here — that is
        // the separate probe-reply family (fish asks for those; nobody asked for 997).
        expect(childRead).not.toContain('997')
        expect(childRead).toContain('hello')
        // Nothing the renderer sent was a color-scheme report, on any path.
        expect(sent.filter((data) => data.includes(COLOR_SCHEME_REPORT_PREFIX))).toEqual([])
        // And fish never echoed one back as literal prompt text.
        expect(rendered).not.toContain('997;1n')

        binding.dispose()
      } finally {
        term.write('exit\r')
        await waitUntil(() => exited, 3_000)
        try {
          term.kill()
        } catch {
          // already gone
        }
      }
    },
    30_000
  )
})
