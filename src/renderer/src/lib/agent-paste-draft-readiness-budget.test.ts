import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { pasteDraftToAgentPtyWhenReady, pasteDraftWhenAgentReady } from './agent-paste-draft'
import { OPENCODE_AGENT_ROW_GRACE_MS } from '../../../shared/opencode-agent-row-scanner'

// These cases drive an older host (no generated-input operation of its own): the shared operation
// with this client's evidence, fed each agent's own startup bytes.
const testState = vi.hoisted(() => {
  const ptyIdsByTabId: Record<string, string[]> = { 'tab-1': ['pty-1'] }
  return {
    observers: [] as ((data: string) => void)[],
    process: 'bash',
    sendInput: vi.fn(),
    ptyIdsByTabId,
    listeners: new Set<(state: unknown) => void>()
  }
})

function storeState() {
  return { settings: {}, tabsByWorktree: {}, ptyIdsByTabId: testState.ptyIdsByTabId }
}

vi.mock('@/runtime/generated-terminal-input-client', () => ({
  sendGeneratedTerminalInput: async () => null
}))
vi.mock('@/store', () => ({
  useAppStore: {
    getState: storeState,
    subscribe: (listener: (state: unknown) => void) => {
      testState.listeners.add(listener)
      return () => testState.listeners.delete(listener)
    }
  }
}))
vi.mock('@/components/terminal-pane/pty-data-sidecar-subscriptions', () => ({
  subscribeToPtyData: (_ptyId: string, observe: (data: string) => void) => {
    testState.observers.push(observe)
    return () => {}
  }
}))
vi.mock('@/components/terminal-pane/pty-pre-handler-buffer', () => ({
  replayPreHandlerPtyData: () => {}
}))
// The pane is mounted and its agent is still starting: observable, so never the blind policy.
vi.mock('@/components/terminal-pane/pty-buffer-serializer', () => ({
  readPtyInputScreen: async () => ({ lines: ['starting…'], alternateScreen: false }),
  readPtyBracketedPasteMode: () => false
}))
vi.mock('@/runtime/runtime-terminal-inspection', () => ({
  inspectRuntimeTerminalProcess: async () => ({
    foregroundProcess: testState.process,
    hasChildProcesses: false
  })
}))
vi.mock('@/runtime/runtime-terminal-verified-input', () => ({
  sendRuntimePtyInputVerified: testState.sendInput
}))
vi.mock('./launch-agent-paste-timeout-notice', () => ({ showGeneratedInputNotice: vi.fn() }))

const PASTE_MODE = '\x1b[?2004h'
const CODEX_PROMPT = '\x1b[1m›\x1b[0m Ask Codex to do anything'
const SHOW_CURSOR = '\x1b[?25h'
const frame = (body: string): string =>
  `\x1b[?2026h\x1b[?25l${body}\x1b[22;27H${SHOW_CURSOR}\x1b[?2026l`
// OpenCode 2.0.21 cold start: the box and its cursor, then the agent row above its corner.
const OPENCODE_BOX = `\x1b[?1049h${PASTE_MODE}${frame('\x1b[21;24H┃\x1b[22;24H┃\x1b[23;24H┃\x1b[24;24H┃\x1b[25;24H╹')}`
const OPENCODE_ROW = frame('\x1b[24;27HBuild\x1b[24;33H·\x1b[24;35HSome Model')

function emit(data: string): void {
  for (const observe of testState.observers) {
    observe(data)
  }
}

describe('agent draft readiness budget through the generated-input operation', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal('window', globalThis)
    testState.observers = []
    testState.process = 'bash'
    testState.sendInput.mockReset()
    testState.sendInput.mockResolvedValue(true)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('delivers when a cold Codex composer becomes ready after 10s, inside the 60s budget', async () => {
    testState.process = 'codex'
    const promise = pasteDraftToAgentPtyWhenReady({
      ptyId: 'pty-1',
      content: 'draft',
      agent: 'codex',
      forcePaste: true
    })
    await vi.advanceTimersByTimeAsync(10_000)
    expect(testState.sendInput).not.toHaveBeenCalled()
    emit(`${PASTE_MODE}${CODEX_PROMPT}`)
    await vi.advanceTimersByTimeAsync(200)
    await expect(promise).resolves.toBe(true)
    expect(testState.sendInput).toHaveBeenCalledExactlyOnceWith(
      'pty-1',
      '\x1b[200~draft\x1b[201~',
      'launch'
    )
  })

  it.each(['opencode', 'opencode2'] as const)(
    'waits for the %s agent row only when Enter follows the paste',
    async (agent) => {
      testState.process = 'opencode'
      const submitted = pasteDraftToAgentPtyWhenReady({
        ptyId: 'pty-1',
        content: 'task',
        agent,
        submit: true,
        forcePaste: true
      })
      await vi.advanceTimersByTimeAsync(0)
      emit(OPENCODE_BOX)
      await vi.advanceTimersByTimeAsync(2000)
      expect(testState.sendInput).not.toHaveBeenCalled()
      emit(OPENCODE_ROW)
      await vi.advanceTimersByTimeAsync(2000)
      await expect(submitted).resolves.toBe(true)

      testState.sendInput.mockClear()
      testState.observers = []
      const drafted = pasteDraftToAgentPtyWhenReady({
        ptyId: 'pty-2',
        content: 'task',
        agent,
        submit: false,
        forcePaste: true
      })
      await vi.advanceTimersByTimeAsync(0)
      emit(OPENCODE_BOX)
      await vi.advanceTimersByTimeAsync(200)
      await expect(drafted).resolves.toBe(true)
    }
  )

  it('does not fall through to paste when the readiness evidence never comes', async () => {
    // ConPTY omits DECSET 2004; distinguish OpenCode's blind-write fallback from observed delivery (#22479).
    testState.process = 'opencode'
    const onUnconfirmedDelivery = vi.fn()
    const promise = pasteDraftToAgentPtyWhenReady({
      ptyId: 'pty-1',
      content: 'draft',
      agent: 'opencode',
      forcePaste: true,
      timeoutMs: 1000,
      onUnconfirmedDelivery
    })
    await vi.advanceTimersByTimeAsync(0)
    emit('booting…')
    await vi.advanceTimersByTimeAsync(1100)
    await expect(promise).resolves.toBe(false)
    expect(testState.sendInput).not.toHaveBeenCalled()
    expect(onUnconfirmedDelivery).not.toHaveBeenCalled()
  })

  // An AI button's pane may settle its grid for longer than the spawn budget before it spawns.
  it.each([true, false])(
    'delivers once the pane says whether it started, however late (%s)',
    async (started) => {
      testState.process = 'claude'
      let answer!: (startedPtyId: string | null) => void
      const promise = pasteDraftWhenAgentReady({
        tabId: 'tab-late',
        content: 'task',
        agent: 'claude',
        submit: true,
        forcePaste: true,
        launchPty: new Promise<string | null>((resolve) => {
          answer = resolve
        })
      })
      await vi.advanceTimersByTimeAsync(13_000)
      testState.ptyIdsByTabId['tab-late'] = ['pty-late']
      testState.listeners.forEach((listener) => listener(storeState()))
      answer(started ? 'pty-late' : null)
      await vi.advanceTimersByTimeAsync(0)
      emit('\x1b[?2004h\x1b[?2031h❯ ')
      await vi.advanceTimersByTimeAsync(2000)
      await expect(promise).resolves.toBe(started)
      const writes = testState.sendInput.mock.calls.map((call) => String(call[1]))
      expect(writes.filter((data) => data.includes('task'))).toHaveLength(started ? 1 : 0)
      expect(writes.filter((data) => data === '\r')).toHaveLength(started ? 1 : 0)
      expect(writes).toHaveLength(started ? 2 : 0)
    }
  )

  it('honors a caller deadline for agents without a specific marker', async () => {
    const onTimeout = vi.fn()
    const promise = pasteDraftToAgentPtyWhenReady({
      ptyId: 'pty-1',
      content: 'draft',
      agent: 'gemini',
      timeoutMs: 8000,
      forcePaste: true,
      onTimeout
    })
    // Output keeps arriving, so no quiet window ever opens before the caller's deadline.
    for (let elapsed = 0; elapsed < 9000; elapsed += 500) {
      emit('.')
      await vi.advanceTimersByTimeAsync(500)
    }
    await expect(promise).resolves.toBe(false)
    expect(onTimeout).toHaveBeenCalledTimes(1)
    expect(testState.sendInput).not.toHaveBeenCalled()
  })

  // OpenCode's agent-row grace runs inside the operation's own observation and budget.
  it('falls back to the box after the grace when OpenCode never paints its agent row', async () => {
    testState.process = 'opencode'
    const promise = pasteDraftToAgentPtyWhenReady({
      ptyId: 'pty-1',
      content: 'task',
      agent: 'opencode2',
      submit: true,
      forcePaste: true,
      timeoutMs: 20_000
    })
    await vi.advanceTimersByTimeAsync(0)
    emit(OPENCODE_BOX)
    await vi.advanceTimersByTimeAsync(OPENCODE_AGENT_ROW_GRACE_MS - 200)
    // More box frames do not restart the grace.
    emit('\x1b[22;27H\x1b[?25h')
    expect(testState.sendInput).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1000)
    await expect(promise).resolves.toBe(true)
  })

  it('refuses at the deadline when the grace would outlast the budget, or after paste turns off', async () => {
    testState.process = 'opencode'
    const late = pasteDraftToAgentPtyWhenReady({
      ptyId: 'pty-1',
      content: 'task',
      agent: 'opencode2',
      submit: true,
      forcePaste: true,
      timeoutMs: 20_000
    })
    await vi.advanceTimersByTimeAsync(19_000)
    emit(OPENCODE_BOX)
    await vi.advanceTimersByTimeAsync(1100)
    await expect(late).resolves.toBe(false)

    testState.observers = []
    const withdrawn = pasteDraftToAgentPtyWhenReady({
      ptyId: 'pty-2',
      content: 'task',
      agent: 'opencode2',
      submit: true,
      forcePaste: true,
      timeoutMs: 20_000
    })
    await vi.advanceTimersByTimeAsync(0)
    emit(OPENCODE_BOX)
    emit('\x1b[?2004l')
    await vi.advanceTimersByTimeAsync(20_100)
    await expect(withdrawn).resolves.toBe(false)
    expect(testState.sendInput).not.toHaveBeenCalled()
  })
})
