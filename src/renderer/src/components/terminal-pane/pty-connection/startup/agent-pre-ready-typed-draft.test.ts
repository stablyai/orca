import { describe, expect, it, vi } from 'vitest'
import type { ConnectPanePtySession } from '../connect-pane-pty-session'
import { installAgentPreReadyTypedDraft } from './agent-pre-ready-typed-draft'
import { deliverPtyLaunchTyped } from '../../pty-transport/delivery/pty-startup-launch-typed'

const delivered = vi.hoisted(() => ({
  pasted: [] as [string, string][],
  noticed: [] as string[]
}))

vi.mock('@/store/index', () => ({
  useAppStore: { getState: () => ({ agentStatusByPaneKey: new Map() }) }
}))
vi.mock('../pane-transport-options', () => ({ paneHasStartupWork: () => true }))
vi.mock('@/lib/agent-session/messaging/paste/agent-draft-readiness', () => ({
  waitForAgentDraftInputReady: async () => true
}))
vi.mock('@/lib/agent-session/messaging/paste/agent-draft-paste-content', () => ({
  sendAgentDraftPasteContent: async (ptyId: string, text: string) => {
    delivered.pasted.push([ptyId, text])
    return true
  }
}))
vi.mock('@/lib/agent-session/launch/prompt/launch-agent-paste-timeout-notice', () => ({
  createPasteReadinessTimeoutNotice: ({ droppedText }: { droppedText: string }) => ({
    onTimeout: () => delivered.noticed.push(droppedText)
  })
}))

function createSession(shellWrapperLaunch: boolean): {
  session: ConnectPanePtySession
  sent: [string, string][]
  bind: (ptyId: string) => void
} {
  let ptyId: string | null = null
  const sent: [string, string][] = []
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the installer only touches the fields this bag defines
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

  it('pastes keys sent at bind once the host types the launch itself, erasing them', async () => {
    delivered.pasted = []
    delivered.noticed = []
    const { session, bind } = createSession(true)
    installAgentPreReadyTypedDraft(session)
    session.captureAgentPreReadyInput('ademark', true)
    bind('pty-2')
    deliverPtyLaunchTyped({ id: 'pty-2', incarnationId: 'incarnation-2' })
    await vi.waitFor(() => expect(delivered.pasted).toEqual([['pty-2', 'ademark']]))
    expect(delivered.noticed).toEqual([])
  })

  it('shows the erased keys in a notice when the user typed after bind', async () => {
    delivered.pasted = []
    delivered.noticed = []
    const { session, bind } = createSession(true)
    installAgentPreReadyTypedDraft(session)
    session.captureAgentPreReadyInput('ademark', true)
    bind('pty-3')
    session.captureAgentPreReadyInput('qz', true)
    deliverPtyLaunchTyped({ id: 'pty-3', incarnationId: 'incarnation-3' })
    await vi.waitFor(() => expect(delivered.noticed).toEqual(['ademark']))
    expect(delivered.pasted).toEqual([])
  })
})
