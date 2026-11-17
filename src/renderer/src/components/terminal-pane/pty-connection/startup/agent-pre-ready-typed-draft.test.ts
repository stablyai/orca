import { describe, expect, it, vi } from 'vitest'
import type { ConnectPanePtySession } from '../connect-pane-pty-session'
import { installAgentPreReadyTypedDraft } from './agent-pre-ready-typed-draft'

vi.mock('@/store/index', () => ({
  useAppStore: { getState: () => ({ agentStatusByPaneKey: new Map() }) }
}))
vi.mock('../pane-transport-options', () => ({ paneHasStartupWork: () => true }))
vi.mock('@/lib/agent-session/messaging/paste/agent-draft-readiness', () => ({
  // The agent never reports ready during these tests.
  waitForAgentDraftInputReady: () => new Promise<boolean>(() => {})
}))

function createSession(): {
  session: ConnectPanePtySession
  sent: [string, string][]
  bind: (ptyId: string) => void
} {
  let ptyId: string | null = null
  const sent: [string, string][] = []
  // oxlint-disable-next-line typescript/consistent-type-assertions -- minimal session bag for the draft installer
  const session = {
    deps: { preconnectInput: [] },
    transportOptions: {},
    paneStartup: { command: 'claude' },
    startupDraftAgent: 'claude',
    requestRecoveryForUndeliverableInput: () => {},
    transport: {
      getPtyId: () => ptyId,
      sendInput: (data: string, kind: string) => {
        sent.push([data, kind])
        return true
      }
    }
  } as unknown as ConnectPanePtySession
  return {
    session,
    sent,
    bind: (id) => {
      ptyId = id
      session.onAgentPreReadyDraftPtyBound(id, true)
    }
  }
}

describe('keys typed while an agent tab connects', () => {
  it('sends the held keys ahead of the first key typed after the terminal binds', () => {
    const { session, sent, bind } = createSession()
    installAgentPreReadyTypedDraft(session)
    expect(session.captureAgentPreReadyInput('ademark', true)).toBe(true)
    bind('pty-1')
    expect(sent).toEqual([])
    expect(session.captureAgentPreReadyInput('q', true)).toBe(false)
    expect(sent).toEqual([['ademark', 'driving']])
    expect(session.captureAgentPreReadyInput('z', true)).toBe(false)
    expect(sent).toEqual([['ademark', 'driving']])
  })
})
