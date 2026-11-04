// @vitest-environment happy-dom
// A created worktree's draft reaches its agent by one of two renderer routes: the pane's own
// startup paste, or the draft helper that waits for the agent. Both must write it as launch input.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TerminalInputKind } from '../../../shared/terminal/input/terminal-input-kind'
import { TUI_AGENT_CONFIG } from '../../../shared/agent-launch/catalog/tui-agent-config'
import { resolveDraftPasteReadyTimeoutMs } from '../../../shared/draft-paste-ready-timeout'
import { bindSettlePaneSerializer } from '@/components/terminal-pane/pty-connection/pane-serializer-settle'
import type { ConnectPanePtySession } from '@/components/terminal-pane/pty-connection/connect-pane-pty-session'
import '@/components/terminal-pane/pty-connection/pty-connect-limits'
import './agent-paste-draft'

const { onTimeout } = vi.hoisted(() => ({ onTimeout: vi.fn() }))
vi.mock('./launch-agent-paste-timeout-notice', () => ({
  createPasteReadinessTimeoutNotice: () => ({ onTimeout })
}))

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({ settings: {}, terminalLayoutsByTabId: {} }),
    subscribe: () => () => {}
  }
}))

vi.mock('./agent-draft-readiness', () => ({
  waitForAgentDraftInputReady: async () => true
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

describe('a created worktree’s startup draft', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    onTimeout.mockClear()
  })

  afterEach(() => {
    vi.useRealTimers()
    window.api = originalApi
  })

  it('never delivers a pane-owned Codex draft after readiness times out', async () => {
    const { session, kinds } = createPaneDraftSession('codex')
    session.observeStartupDraftPasteReadiness('\x1b[?2004hWaiting for Codex...')
    await vi.advanceTimersByTimeAsync(resolveDraftPasteReadyTimeoutMs('codex'))

    expect(onTimeout).toHaveBeenCalledOnce()
    expect(kinds).toEqual([])
    session.observeStartupDraftPasteReadiness('\x1b[2K› ')
    await vi.runAllTimersAsync()
    expect(kinds).toEqual([])
    expect(onTimeout).toHaveBeenCalledOnce()
  })
})
