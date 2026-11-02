// @vitest-environment happy-dom
// A created worktree's draft reaches its agent by one of two renderer routes: the pane's own
// startup paste, or the draft helper that waits for the agent. Both must write it as launch input.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TerminalInputKind } from '../../../shared/terminal-input-kind'
import { TUI_AGENT_CONFIG } from '../../../shared/tui-agent-config'
import { GENERATED_AGENT_INPUT_TIMEOUT_MS } from '../../../shared/generated-agent-input-readiness'
import { bindSettlePaneSerializer } from '@/components/terminal-pane/pty-connection/pane-serializer-settle'
import type { ConnectPanePtySession } from '@/components/terminal-pane/pty-connection/connect-pane-pty-session'
import { STARTUP_DRAFT_PASTE_QUIET_MS } from '@/components/terminal-pane/pty-connection/pty-connect-limits'
import { pasteDraftToAgentPtyWhenReady } from './agent-paste-draft'
import type * as PtyBufferSerializerModule from '@/components/terminal-pane/pty-buffer-serializer'

const { onTimeout, readiness } = vi.hoisted(() => ({
  onTimeout: vi.fn(),
  readiness: { ready: true }
}))
// These cases drive the legacy adapter: a paired host older than the generated-input transaction.
vi.mock('@/runtime/generated-terminal-input-client', () => ({
  sendGeneratedTerminalInput: async () => null
}))
vi.mock('./launch-agent-paste-timeout-notice', () => ({
  createPasteReadinessTimeoutNotice: () => ({ onTimeout }),
  showGeneratedInputNotice: vi.fn()
}))

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({ settings: {}, terminalLayoutsByTabId: {} }),
    subscribe: () => () => {}
  }
}))

// The agent's own screen and process are the facts; the shared operation decides from them.
vi.mock('@/components/terminal-pane/pty-buffer-serializer', async (importOriginal) => ({
  ...(await importOriginal<typeof PtyBufferSerializerModule>()),
  readPtyInputScreen: async () => ({
    lines: readiness.ready ? ['> '] : ['Waiting for Codex...'],
    alternateScreen: false
  }),
  readPtyBracketedPasteMode: () => true
}))
vi.mock('@/components/terminal-pane/pty-data-sidecar-subscriptions', () => ({
  subscribeToPtyData: () => () => {}
}))
vi.mock('@/runtime/runtime-terminal-inspection', () => ({
  inspectRuntimeTerminalProcess: async () => ({
    foregroundProcess: readiness.ready ? 'aider' : 'codex',
    hasChildProcesses: false
  })
}))

const DRAFT = 'plan the migration'
const originalApi = window.api

function stubPtyApi(): { kinds: TerminalInputKind[] } {
  const kinds: TerminalInputKind[] = []
  const writeAccepted = vi.fn(async (_id: string, _data: string, inputKind: TerminalInputKind) => {
    kinds.push(inputKind)
    return true
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: both routes reach only pty.writeAccepted.
  window.api = { pty: { writeAccepted, write: vi.fn() } } as unknown as typeof window.api
  return { kinds }
}

function createPaneDraftSession(agent?: 'codex') {
  const { kinds } = stubPtyApi()
  const transport = {
    getPtyId: () => 'pty-1',
    sendInput: () => true,
    sendInputAccepted: (data: string, inputKind: TerminalInputKind) =>
      window.api.pty.writeAccepted('pty-1', data, inputKind)
  }
  const pane = { id: 1 }
  const bag: Record<string, unknown> = {
    pane,
    transport,
    disposed: false,
    connectionId: null,
    ownsStartupDraftPaste: true,
    shouldDeliverStartupViaTerminalPaste: false,
    startupDraftPrompt: DRAFT,
    startupDraftAgent: agent,
    startupDraftAgentConfig: agent ? TUI_AGENT_CONFIG[agent] : undefined,
    recordTerminalInputForHibernation: () => {},
    deps: { worktreeId: 'wt-1', paneTransportsRef: { current: new Map([[pane.id, transport]]) } }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the session is an any-typed bag; the draft path reads only the fields above.
  const session = bag as unknown as ConnectPanePtySession
  bindSettlePaneSerializer(session)
  return { session, kinds }
}

async function paneRouteKinds(): Promise<TerminalInputKind[]> {
  const { session, kinds } = createPaneDraftSession()
  session.observeStartupDraftPasteReadiness('\x1b[?2004h')
  await vi.advanceTimersByTimeAsync(STARTUP_DRAFT_PASTE_QUIET_MS)
  await vi.runAllTimersAsync()
  return kinds
}

async function helperRouteKinds(): Promise<TerminalInputKind[]> {
  const { kinds } = stubPtyApi()
  const pasted = pasteDraftToAgentPtyWhenReady({
    ptyId: 'pty-1',
    content: DRAFT,
    agent: 'aider'
  })
  await vi.runAllTimersAsync()
  await expect(pasted).resolves.toBe(true)
  return kinds
}

describe('a created worktree’s startup draft', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    onTimeout.mockClear()
    readiness.ready = true
  })

  afterEach(() => {
    vi.useRealTimers()
    window.api = originalApi
  })

  it('writes as launch input on both renderer routes', async () => {
    const paneKinds = await paneRouteKinds()
    const helperKinds = await helperRouteKinds()

    expect(paneKinds.length).toBeGreaterThan(0)
    expect(new Set(paneKinds)).toEqual(new Set(['launch']))
    expect(new Set(helperKinds)).toEqual(new Set(paneKinds))
  })

  it('never delivers a pane-owned Codex draft after readiness times out', async () => {
    readiness.ready = false
    const { session, kinds } = createPaneDraftSession('codex')
    session.observeStartupDraftPasteReadiness('\x1b[?2004hWaiting for Codex...')
    await vi.advanceTimersByTimeAsync(GENERATED_AGENT_INPUT_TIMEOUT_MS)

    expect(onTimeout).toHaveBeenCalledOnce()
    expect(kinds).toEqual([])
    session.observeStartupDraftPasteReadiness('\x1b[2K› ')
    await vi.runAllTimersAsync()
    expect(kinds).toEqual([])
    expect(onTimeout).toHaveBeenCalledOnce()
  })
})
