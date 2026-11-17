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

function createSession(shellWrapperLaunch: boolean): {
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
    spawnShellWrapperLaunch: shellWrapperLaunch,
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
  it('sends them at bind when the shell wrapper runs the launch, ahead of later typing', () => {
    const { session, sent, bind } = createSession(true)
    installAgentPreReadyTypedDraft(session)
    expect(session.captureAgentPreReadyInput('ademark', true)).toBe(true)
    bind('pty-1')
    expect(sent).toEqual([['ademark', 'driving']])
    expect(session.captureAgentPreReadyInput('qz', true)).toBe(false)
  })

  it('keeps holding them for the agent when the launch is typed into the shell', () => {
    const { session, sent, bind } = createSession(false)
    installAgentPreReadyTypedDraft(session)
    session.captureAgentPreReadyInput('ademark', true)
    bind('pty-1')
    expect(sent).toEqual([])
  })
})
