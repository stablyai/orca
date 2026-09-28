// @vitest-environment happy-dom
// A created worktree's draft reaches its agent by one of two renderer routes: the pane's own
// startup paste, or the draft helper that waits for the agent. Both must write it as launch input.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TerminalInputKind } from '../../../shared/terminal-input-kind'
import { bindSettlePaneSerializer } from '@/components/terminal-pane/pty-connection/pane-serializer-settle'
import type { ConnectPanePtySession } from '@/components/terminal-pane/pty-connection/connect-pane-pty-session'
import { STARTUP_DRAFT_PASTE_QUIET_MS } from '@/components/terminal-pane/pty-connection/pty-connect-limits'
import { pasteDraftToAgentPtyWhenReady, submitPromptToAgentPty } from './agent-paste-draft'

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({ settings: {}, terminalLayoutsByTabId: {} }),
    subscribe: () => () => {}
  }
}))

vi.mock('./worktree-runtime-owner', () => ({
  getSettingsForWorktreeRuntimeOwner: () => ({}),
  getRuntimeEnvironmentIdForWorktree: () => null
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

/** The pane route: the pane's transport pastes the draft once the agent's composer is ready. */
async function paneRouteKinds(): Promise<TerminalInputKind[]> {
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
    recordTerminalInputForHibernation: () => {},
    deps: { worktreeId: 'wt-1', paneTransportsRef: { current: new Map([[pane.id, transport]]) } }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the session is an any-typed bag; the draft path reads only the fields above.
  const session = bag as unknown as ConnectPanePtySession
  bindSettlePaneSerializer(session)
  session.observeStartupDraftPasteReadiness('\x1b[?2004h')
  await vi.advanceTimersByTimeAsync(STARTUP_DRAFT_PASTE_QUIET_MS)
  await vi.runAllTimersAsync()
  return kinds
}

/** The helper route: the draft helper waits for the agent, then writes through the runtime. */
async function helperRouteKinds(): Promise<TerminalInputKind[]> {
  const { kinds } = stubPtyApi()
  const pasted = pasteDraftToAgentPtyWhenReady({
    tabId: 'tab-1',
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

  it('differs from a prompt submitted to an agent that is already running', async () => {
    const { kinds } = stubPtyApi()

    const submitted = submitPromptToAgentPty({ tabId: 'tab-1', ptyId: 'pty-1', content: DRAFT })
    await vi.runAllTimersAsync()

    await expect(submitted).resolves.toBe(true)
    expect(new Set(kinds)).toEqual(new Set(['driving']))
  })
})
